#!/usr/bin/env python3
"""Test-only SSH server for e2e verification of ssh-tunnel-manager-web.

Implements just enough OpenSSH server behavior for `ssh -N -L ...`:
  - public key authentication against a single authorized key
  - direct-tcpip channel handling (local port forward data path)
  - rejects session/shell/exec channels (the app starts tunnels with -N)

Usage:
  fake_sshd.py --port 2022 --host-key hostkey_ed25519 \\
               --authorized-key ssh-keys/id_ed25519_test.pub
"""
import argparse
import base64
import socket
import sys
import threading

import paramiko

LOG = lambda msg: print("[fake_sshd] %s" % msg, flush=True)


def load_authorized_blob(path):
    with open(path, "r") as fh:
        parts = fh.read().split()
    if len(parts) < 2 or not parts[1]:
        raise SystemExit("invalid authorized key file: %s" % path)
    return base64.b64decode(parts[1])


class TunnelServer(paramiko.ServerInterface):
    def __init__(self, authorized_blob, pending, password=None):
        self.authorized_blob = authorized_blob
        self.pending = pending  # {channel id: connected upstream socket}
        self.password = password  # when set, password auth is also accepted

    def get_allowed_auths(self, username):
        return "publickey,password" if self.password is not None else "publickey"

    def check_auth_publickey(self, username, key):
        if key.asbytes() == self.authorized_blob:
            LOG("auth ok user=%s key=%s" % (username, key.get_name()))
            return paramiko.AUTH_SUCCESSFUL
        return paramiko.AUTH_FAILED

    def check_auth_password(self, username, password):
        if self.password is not None and password == self.password:
            LOG("auth ok user=%s method=password" % username)
            return paramiko.AUTH_SUCCESSFUL
        LOG("password auth rejected for user=%s" % username)
        return paramiko.AUTH_FAILED

    def check_channel_request(self, kind, chanid):
        # No interactive sessions; the app only ever forwards.
        return paramiko.OPEN_FAILED_ADMINISTRATIVELY_PROHIBITED

    def check_channel_direct_tcpip_request(self, chanid, origin, destination):
        LOG("forward request from %s:%d -> %s:%d" % (origin[0], origin[1], destination[0], destination[1]))
        try:
            upstream = socket.create_connection(destination, timeout=5)
        except OSError as exc:
            LOG("upstream connect failed: %s" % exc)
            return paramiko.OPEN_FAILED_CONNECT_FAILED
        upstream.settimeout(None)
        self.pending[chanid] = upstream
        return paramiko.OPEN_SUCCEEDED

    def check_global_request(self, kind, msg):
        return False


def pump(direction, src, dst):
    try:
        while True:
            data = src.recv(32768)
            if not data:
                break
            if direction == "up":
                dst.sendall(data)
            else:
                dst.sendall(data)
    except Exception:
        pass
    finally:
        try:
            if direction == "up":
                dst.shutdown(socket.SHUT_WR)
            else:
                dst.shutdown_write()  # paramiko Channel half-close
        except Exception:
            pass


def serve_channel(chan, upstream):
    t1 = threading.Thread(target=pump, args=("up", chan, upstream), daemon=True)
    t2 = threading.Thread(target=pump, args=("down", upstream, chan), daemon=True)
    t1.start()
    t2.start()
    t1.join()
    t2.join()
    chan.close()
    upstream.close()


def handle_client(client, host_key, authorized_blob, pending, password=None):
    transport = paramiko.Transport(client)
    transport.add_server_key(host_key)
    server = TunnelServer(authorized_blob, pending, password)
    try:
        transport.start_server(server=server)
        while True:
            chan = transport.accept(timeout=2)
            if chan is None:
                if not transport.is_active():
                    break
                continue
            upstream = pending.pop(chan.chanid, None)
            if upstream is None:
                LOG("channel %s opened without pending upstream; closing" % chan.chanid)
                chan.close()
                continue
            LOG("channel %s established; pumping data" % chan.chanid)
            threading.Thread(target=serve_channel, args=(chan, upstream), daemon=True).start()
    except Exception as exc:
        LOG("client error: %s" % exc)
    finally:
        transport.close()
        client.close()
        LOG("connection closed")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=2022)
    parser.add_argument("--host-key", required=True)
    parser.add_argument("--authorized-key", required=True)
    parser.add_argument("--password", default=None,
                        help="if set, also accept this password (enables password auth)")
    args = parser.parse_args()

    host_key = paramiko.Ed25519Key(filename=args.host_key)
    authorized_blob = load_authorized_blob(args.authorized_key)

    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.bind(("127.0.0.1", args.port))
    sock.listen(16)
    LOG("listening on 127.0.0.1:%d" % args.port)

    while True:
        client, addr = sock.accept()
        LOG("connection from %s:%d" % addr)
        pending = {}
        threading.Thread(target=handle_client, args=(client, host_key, authorized_blob, pending, args.password), daemon=True).start()


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(0)
