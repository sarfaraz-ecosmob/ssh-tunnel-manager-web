#!/usr/bin/env python3
"""Test-only HTTP service used as the tunnel's remote target.

Listens on 127.0.0.1:8099 and answers every request with a fixed marker so
tests can prove traffic traversed the SSH tunnel end-to-end.
"""
import argparse
from http.server import BaseHTTPRequestHandler, HTTPServer

MARKER = "E2E_TARGET_OK traffic traversed the ssh tunnel"


class Handler(BaseHTTPRequestHandler):
    def _respond(self):
        body = (MARKER + "\n").encode()
        print("[target] served %s -> %s" % (self.path, MARKER), flush=True)
        self.send_response(200)
        self.send_header("Content-Type", "text/plain")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    do_GET = _respond
    do_POST = _respond

    def log_message(self, fmt, *args):
        print("[target] %s - %s" % (self.address_string(), fmt % args), flush=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8099)
    args = parser.parse_args()
    server = HTTPServer(("127.0.0.1", args.port), Handler)
    print("[target] listening on 127.0.0.1:%d" % args.port, flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
