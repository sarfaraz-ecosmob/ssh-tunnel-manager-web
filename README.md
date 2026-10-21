# SSH Tunnel Manager Web

A self-hosted starter web app for managing OpenSSH local port forwards from a Linux server. It is inspired by the profile and one-click start/stop workflow of [mdminhazulhaque/ssh-tunnel-manager](https://github.com/mdminhazulhaque/ssh-tunnel-manager), but it is a separate web implementation.

## Current scope

- Single admin login, session cookie, CSRF token, login rate limit
- Add/edit/delete tunnel profiles
- Start/stop local SSH port forwards using OpenSSH
- SQLite persistence in `./data`
- Live status refresh and recent SSH logs
- SSH host key checking is enforced
- SSH key directory is mounted read-only
- Optional allowlists for SSH hosts and remote targets


In the UI, create a tunnel using the key filename, SSH host/user, local port, and remote target. Start the tunnel and verify from the host/network namespace that the local port is reachable.

