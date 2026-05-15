package http

import (
	"github.com/gin-gonic/gin"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	"net/http"
)

func NewRouter(h *Handler, metricsEnabled bool) *gin.Engine {
	gin.SetMode(gin.ReleaseMode)
	r := gin.New()
	r.Use(gin.Logger(), gin.Recovery(), corsMiddleware())

	r.GET("/health", h.Health)

	if metricsEnabled {
		r.GET("/metrics", func(c *gin.Context) {
			promhttp.Handler().ServeHTTP(c.Writer, c.Request)
		})
	}

	v1 := r.Group("/api/v1")
	{
		v1.GET("/stats", h.GetStats)
		v1.GET("/executions", h.ListExecutions)
		v1.GET("/keeper/health", h.GetKeeperHealth)
		v1.POST("/strategies", h.RegisterStrategy)
		v1.POST("/strategies/:hash/done", h.MarkStrategyDone)
		v1.POST("/dca-strategies", h.RegisterDcaGroup)
	}

	return r
}

func corsMiddleware() gin.HandlerFunc {
	return func(c *gin.Context) {
		c.Header("Access-Control-Allow-Origin", "*")
		c.Header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		c.Header("Access-Control-Allow-Headers", "Content-Type, Authorization")
		if c.Request.Method == http.MethodOptions {
			c.AbortWithStatus(http.StatusNoContent)
			return
		}
		c.Next()
	}
}
