ID := com.github.morraycage.read-receipts
VERSION := $(shell python3 -c 'import json;print(json.load(open("plugin.json"))["version"])')
BUNDLE := dist/$(ID)-$(VERSION).tar.gz
# macOS bsdtar would otherwise add AppleDouble files.
TARFLAGS := $(shell tar --version 2>/dev/null | grep -q bsdtar && echo --no-xattrs --no-mac-metadata)

.PHONY: all server webapp bundle clean
all: bundle

server:
	cd server && go vet .
	for arch in amd64 arm64; do \
	  CGO_ENABLED=0 GOOS=linux GOARCH=$$arch go build -trimpath -ldflags='-s -w' -o server/dist/plugin-linux-$$arch ./server; \
	done

webapp:
	cd webapp && npm ci --silent && npm run -s build

bundle: server webapp
	rm -rf dist/$(ID) && mkdir -p dist/$(ID)/server/dist dist/$(ID)/webapp/dist
	cp plugin.json dist/$(ID)/
	cp server/dist/plugin-linux-* dist/$(ID)/server/dist/
	cp webapp/dist/main.js dist/$(ID)/webapp/dist/
	cd dist && COPYFILE_DISABLE=1 tar $(TARFLAGS) -czf $(ID)-$(VERSION).tar.gz $(ID)
	@echo $(BUNDLE)

clean:
	rm -rf dist server/dist webapp/dist
