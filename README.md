<p align="center">
  <h1 align="center">MAX Messenger Plugin for Claude Code</h1>
  <p align="center">
    Connect Claude Code AI agents to <a href="https://max.ru">MAX Messenger</a> (VK) via Bot API
  </p>
  <p align="center">
    <a href="#features">Features</a> &bull;
    <a href="#quick-start">Quick Start</a> &bull;
    <a href="#tools">Tools</a> &bull;
    <a href="#access-control">Access Control</a>
  </p>
</p>

---

MCP channel plugin that bridges [MAX Messenger](https://max.ru) Bot API to [Claude Code](https://claude.ai/code) sessions. Send messages, receive replies, share files — all through Claude Code's channel system.

## Features

- **Real-time messaging** — long-poll based message receiving with instant delivery
- **Send & receive** — full text messaging with Markdown support
- **Edit messages** — update sent messages without push notifications (perfect for progress updates)
- **File sharing** — upload and send files up to 50 MB (images display inline)
- **Auto-chunking** — long messages automatically split at 4000 char limit
- **Access control** — flexible allowlist, open, or disabled modes
- **Typing indicator** — shows "typing..." while agent processes
- **Graceful shutdown** — clean disconnect on exit
- **Multi-agent** — run multiple agents with separate bot tokens and configs

## Quick Start

### 1. Create a MAX bot

- Go to [MAX Business](https://business.max.ru)
- Create a bot and get it approved
- Copy the bot token from the **Integration** section

### 2. Install

```bash
git clone https://github.com/MAVII-RU/max-messenger-plugin.git
cd max-messenger-plugin
chmod +x install.sh
./install.sh
```

The installer will:
- Copy the plugin to `~/.claude/plugins/local/max-messenger/`
- Create config directories
- Ask for your bot token
- Install dependencies (requires [Bun](https://bun.sh))

### 3. Run Claude Code with the channel

```bash
claude --dangerously-load-development-channels server:max-messenger
```

## Manual Installation

```bash
# Copy plugin
mkdir -p ~/.claude/plugins/local/max-messenger
cp -r . ~/.claude/plugins/local/max-messenger/

# Create config
mkdir -p ~/.claude/channels/max
echo "MAX_BOT_TOKEN=your_token_here" > ~/.claude/channels/max/.env
chmod 600 ~/.claude/channels/max/.env

# Create access control
cat > ~/.claude/channels/max/access.json << 'EOF'
{
  "dmPolicy": "open",
  "allowFrom": [],
  "groups": {}
}
EOF

# Install dependencies
cd ~/.claude/plugins/local/max-messenger
bun install
```

## Tools

The plugin exposes three MCP tools to Claude Code:

| Tool | Description |
|------|-------------|
| `reply` | Send a reply to a MAX chat. Supports text up to 4000 chars (auto-chunked). Pass `chat_id` from inbound message. |
| `edit_message` | Edit a previously sent message. Edits don't trigger push notifications — ideal for progress updates. |
| `send_file` | Send a file attachment (absolute path, max 50 MB). Images render inline. |

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `MAX_BOT_TOKEN` | Yes | Bot token from MAX Business |
| `MAX_STATE_DIR` | No | Config directory (default: `~/.claude/channels/max`) |

## Access Control

Configure `~/.claude/channels/max/access.json`:

```json
{
  "dmPolicy": "allowlist",
  "allowFrom": ["user_id_1", "user_id_2"],
  "groups": {
    "-group_chat_id": {
      "allowFrom": ["user_id_1"]
    }
  }
}
```

### DM Policy Options

| Policy | Behavior |
|--------|----------|
| `open` | Accept messages from everyone |
| `allowlist` | Only from listed user IDs |
| `disabled` | Reject all DMs |

### Group Chats

Groups require explicit configuration. Add the group chat ID to the `groups` object with its own `allowFrom` list. Messages from unlisted users in configured groups are silently ignored.

## Multi-Agent Setup

Run multiple agents with separate configs by setting `MAX_STATE_DIR`:

```bash
# Agent 1
export MAX_STATE_DIR=~/.claude-agent1/channels/max
claude --dangerously-load-development-channels server:max-messenger

# Agent 2
export MAX_STATE_DIR=~/.claude-agent2/channels/max
claude --dangerously-load-development-channels server:max-messenger
```

Each agent needs its own bot token and `access.json` in its state directory.

## MAX Bot API Reference

- **Base URL:** `https://platform-api.max.ru`
- **Documentation:** [dev.max.ru/docs-api](https://dev.max.ru/docs-api)
- **Rate limit:** 30 requests/second
- **Auth:** `Authorization: <token>` header

## Requirements

- [Bun](https://bun.sh) v1.0+ runtime
- [Claude Code](https://claude.ai/code) v2.1+

## License

MIT — see [LICENSE](LICENSE)
