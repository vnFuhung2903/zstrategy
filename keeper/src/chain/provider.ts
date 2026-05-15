import { ethers } from "ethers";
import { config } from "../config";

// Single shared provider + signer — created once, reused everywhere.
export const provider = new ethers.JsonRpcProvider(config.rpcUrl, config.chainId);
export const signer   = new ethers.Wallet(config.keeperPrivateKey, provider);
