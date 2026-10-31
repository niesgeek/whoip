// Package web embeds the static frontend (the Alpine app, API docs, and OpenAPI spec) so
// it ships inside the single binary and the Vercel function alike.
package web

import (
	"embed"
	"io/fs"
)

//go:embed static
var files embed.FS

// FS returns the embedded static assets rooted at the static directory.
func FS() fs.FS {
	sub, err := fs.Sub(files, "static")
	if err != nil {
		panic(err) // embedded path is a compile-time constant; this cannot fail
	}
	return sub
}
