// Command server runs Who-Dat as a standalone HTTP server
// used for local dev, the Docker image, and downloadable binaries
package main

import (
	"log/slog"
	"net/http"
	"os"
	"time"

	"github.com/lissy93/who-dat/internal/config"
	"github.com/lissy93/who-dat/internal/server"
)

var version = "dev"

func main() {
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, nil)))

	cfg := config.Load()
	handler := server.Build(cfg)

	srv := &http.Server{
		Addr:              ":" + cfg.Port,
		Handler:           handler,
		ReadHeaderTimeout: 5 * time.Second,
		IdleTimeout:       120 * time.Second,
	}

	slog.Info("who-dat listening", "version", version, "port", cfg.Port, "cache", cfg.EnableCache, "auth", cfg.AuthEnabled())
	if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		slog.Error("server stopped", "err", err)
		os.Exit(1)
	}
}
