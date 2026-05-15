package indexer

import (
	"context"
	"fmt"
	"log"
	"math/big"
	"strings"
	"time"

	"github.com/ethereum/go-ethereum"
	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/types"
	"github.com/ethereum/go-ethereum/ethclient"
	"github.com/zstrategy/backend/internal/service"
)

const registryABI = `[
  {"type":"event","name":"CommitmentRegistered","inputs":[{"name":"commitmentHash","type":"bytes32","indexed":true},{"name":"owner","type":"address","indexed":true},{"name":"tokenIn","type":"address","indexed":false},{"name":"tokenOut","type":"address","indexed":false},{"name":"size","type":"uint256","indexed":false},{"name":"expiry","type":"uint64","indexed":false},{"name":"kind","type":"uint8","indexed":false}]},
  {"type":"event","name":"CommitmentExecuted","inputs":[{"name":"commitmentHash","type":"bytes32","indexed":true},{"name":"owner","type":"address","indexed":true},{"name":"executor","type":"address","indexed":true},{"name":"nullifier","type":"bytes32","indexed":false},{"name":"fillRef","type":"uint64","indexed":false},{"name":"amountOut","type":"uint256","indexed":false},{"name":"kind","type":"uint8","indexed":false}]},
  {"type":"event","name":"CommitmentCancelled","inputs":[{"name":"commitmentHash","type":"bytes32","indexed":true},{"name":"owner","type":"address","indexed":true}]},
  {"type":"event","name":"CommitmentExpired","inputs":[{"name":"commitmentHash","type":"bytes32","indexed":true},{"name":"owner","type":"address","indexed":true}]}
]`

type ChainIndexer struct {
	client          *ethclient.Client
	contractAddress common.Address
	chainID         int64
	parsedABI       abi.ABI
	svc             *service.IndexerService
}

func New(rpcURL, contractAddress string, chainID int64, svc *service.IndexerService) (*ChainIndexer, error) {
	client, err := ethclient.Dial(rpcURL)
	if err != nil {
		return nil, fmt.Errorf("dial rpc: %w", err)
	}
	parsed, err := abi.JSON(strings.NewReader(registryABI))
	if err != nil {
		return nil, fmt.Errorf("parse abi: %w", err)
	}
	return &ChainIndexer{
		client:          client,
		contractAddress: common.HexToAddress(contractAddress),
		chainID:         chainID,
		parsedABI:       parsed,
		svc:             svc,
	}, nil
}

func (ci *ChainIndexer) Run(ctx context.Context) {
	query := ethereum.FilterQuery{Addresses: []common.Address{ci.contractAddress}}
	logs := make(chan types.Log, 64)

	sub, err := ci.client.SubscribeFilterLogs(ctx, query, logs)
	if err != nil {
		log.Printf("[indexer] ws subscribe failed (%v), falling back to poll", err)
		ci.poll(ctx)
		return
	}
	defer sub.Unsubscribe()
	log.Printf("[indexer] subscribed to %s (chain %d)", ci.contractAddress.Hex(), ci.chainID)

	for {
		select {
		case <-ctx.Done():
			return
		case err := <-sub.Err():
			log.Printf("[indexer] subscription error: %v — reconnecting in 5s", err)
			time.Sleep(5 * time.Second)
			ci.Run(ctx)
			return
		case vLog := <-logs:
			ci.handleLog(ctx, vLog)
		}
	}
}

func (ci *ChainIndexer) poll(ctx context.Context) {
	ticker := time.NewTicker(15 * time.Second)
	defer ticker.Stop()
	var fromBlock *big.Int

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			latest, err := ci.client.BlockNumber(ctx)
			if err != nil {
				log.Printf("[indexer] poll block number: %v", err)
				continue
			}
			if fromBlock == nil {
				start := latest
				if latest > 1000 {
					start = latest - 1000
				}
				fromBlock = new(big.Int).SetUint64(start)
			}
			toBlock := new(big.Int).SetUint64(latest)
			filterLogs, err := ci.client.FilterLogs(ctx, ethereum.FilterQuery{
				FromBlock: fromBlock,
				ToBlock:   toBlock,
				Addresses: []common.Address{ci.contractAddress},
			})
			if err != nil {
				log.Printf("[indexer] filter logs: %v", err)
				continue
			}
			for _, l := range filterLogs {
				ci.handleLog(ctx, l)
			}
			fromBlock = new(big.Int).Add(toBlock, big.NewInt(1))
		}
	}
}

func (ci *ChainIndexer) handleLog(ctx context.Context, vLog types.Log) {
	if len(vLog.Topics) == 0 {
		return
	}

	blockTime := time.Now().UTC()
	if block, err := ci.client.BlockByHash(ctx, vLog.BlockHash); err == nil {
		blockTime = time.Unix(int64(block.Time()), 0).UTC()
	}

	commitmentHash := "0x" + fmt.Sprintf("%x", vLog.Topics[1])
	txHash := vLog.TxHash.Hex()

	switch vLog.Topics[0] {
	case ci.parsedABI.Events["CommitmentRegistered"].ID:
		log.Printf("[indexer] CommitmentRegistered %s", commitmentHash)
		// Decode non-indexed fields to extract kind (last field, uint8).
		kind := "ORDER_FILL"
		decoded := make(map[string]interface{})
		if err := ci.parsedABI.Events["CommitmentRegistered"].Inputs.UnpackIntoMap(decoded, vLog.Data); err == nil {
			if k, ok := decoded["kind"].(uint8); ok && k == 1 {
				kind = "DCA"
			}
		}
		if err := ci.svc.HandleRegistered(ctx, commitmentHash, kind, ci.chainID, blockTime); err != nil {
			log.Printf("[indexer] HandleRegistered: %v", err)
		}

	case ci.parsedABI.Events["CommitmentExecuted"].ID:
		log.Printf("[indexer] CommitmentExecuted %s", commitmentHash)
		var gasUsed uint64
		if receipt, err := ci.client.TransactionReceipt(ctx, vLog.TxHash); err == nil {
			gasUsed = receipt.GasUsed
		}
		if err := ci.svc.HandleExecuted(ctx, commitmentHash, txHash, ci.chainID, vLog.BlockNumber, gasUsed, blockTime); err != nil {
			log.Printf("[indexer] HandleExecuted: %v", err)
		}

	case ci.parsedABI.Events["CommitmentCancelled"].ID:
		log.Printf("[indexer] CommitmentCancelled %s", commitmentHash)
		if err := ci.svc.HandleCancelled(ctx, commitmentHash, txHash, vLog.BlockNumber); err != nil {
			log.Printf("[indexer] HandleCancelled: %v", err)
		}

	case ci.parsedABI.Events["CommitmentExpired"].ID:
		log.Printf("[indexer] CommitmentExpired %s", commitmentHash)
		if err := ci.svc.HandleExpired(ctx, commitmentHash, vLog.BlockNumber); err != nil {
			log.Printf("[indexer] HandleExpired: %v", err)
		}
	}
}
