# PingPal GitHub-to-Telegram Monitor Plugin (plugin-pingpal-github)

This ElizaOS plugin, `plugin-pingpal-github`, monitors GitHub notifications for a specified user account, analyzes their importance using a Language Model (LLM), and sends notifications for critical items to a designated Telegram chat. It is designed to help developers manage GitHub notification overload by filtering out noise and ensuring timely awareness of important pull requests, issues, mentions, and review requests.

This plugin uses the GitHub API for direct notification polling and integrates with `@elizaos/plugin-telegram` for sending notifications.

## Key Features

- **Direct GitHub API Monitoring:** Connects to GitHub via personal access token to poll for notifications at regular intervals.
- **LLM-Powered Importance Analysis:** Utilizes an LLM via `runtime.useModel` to analyze the context and content of GitHub notifications to determine their importance and generate a concise summary.
- **Telegram Notifications:** Sends private Telegram messages for notifications deemed important, including the repository, subject, reason for importance, and a direct link to the GitHub item.
- **Deduplication:** Prevents duplicate notifications for the same GitHub notification ID by tracking processed notifications in the database.
- **Configurable Filtering:** Focuses on relevant notification types including mentions, review requests, assignments, and author notifications.

## How It Works

1.  **Initialization (`init` in `src/plugin.ts`):**

    - The plugin validates required environment variables for GitHub access token, target username, and Telegram user ID.
    - It creates an agent-specific internal room for logging if it doesn't exist.
    - Sets up a 30-second polling interval to check for new GitHub notifications.

2.  **GitHub Notification Polling (`POLL_GITHUB_NOTIFICATIONS` action in `src/actions/pollGitHubNotifications.ts`):**

    - Every 30 seconds, the plugin fetches the last 20 notifications (both read and unread) from GitHub API.
    - Filters for relevant notification types: `mention`, `review_requested`, `assign`, and `author`.
    - For each relevant notification, triggers the analysis action.

3.  **Notification Analysis (`ANALYZE_GITHUB_NOTIFICATION` action in `src/actions/analyzeGitHubNotification.ts`):**

    - Before analysis, checks if the notification ID has already been processed using database memories (table: `pingpal_github_processed`) to prevent duplicates.
    - If it's a new notification, constructs a prompt with the notification details and sends it to an LLM using `runtime.useModel`.
    - The LLM responds with a JSON object indicating if the notification is `important` and provides a `reason` for the classification.
    - The analysis result and original notification details are logged as an ElizaOS memory for persistence.

4.  **Telegram Notification (`SEND_TELEGRAM_NOTIFICATION` action in `src/actions/sendTelegramNotification.ts`):**
    - If the analysis determines the notification is important, triggers the Telegram notification action.
    - Formats a rich message containing the repository name, notification type, subject, timestamp, and importance reason.
    - Uses the `@elizaos/plugin-telegram` service to send this message as a private notification to the configured `targetTelegramUserId`.
    - Includes a direct link to the relevant GitHub issue or pull request for quick access.

## Setup and Configuration

To use this plugin, you need to configure your ElizaOS agent and provide necessary credentials and settings.

### 1. Environment Variables

Create a `.env` file in your ElizaOS project root with the following variables:

```env
# GitHub API Details (for monitoring notifications)
GITHUB_ACCESS_TOKEN="ghp_your_github_personal_access_token"
PINGPAL_TARGET_GITHUB_USERNAME="your_github_username"

# Telegram Bot Details (for sending notifications)
# This bot will send notifications TO the targetTelegramUserId.
# The target user MUST /start a chat with this bot once.
TELEGRAM_BOT_TOKEN="your_telegram_bot_token"
PINGPAL_TARGET_TELEGRAM_USERID="your_numerical_telegram_user_id"

# LLM Provider API Key (e.g., OpenAI)
OPENAI_API_KEY="your_llm_api_key" # Or other relevant key for your LLM provider
```

**Important Notes:**

- **GitHub Personal Access Token:** Create a personal access token on GitHub with `notifications` and `repo` scopes. Go to Settings → Developer settings → Personal access tokens → Generate new token.
- **Target Telegram User ID:** This is your numerical Telegram User ID. You can get it by messaging a bot like `@userinfobot` on Telegram.
- **Telegram Bot:** The `TELEGRAM_BOT_TOKEN` is for a bot you create (via BotFather on Telegram). The user specified by `PINGPAL_TARGET_TELEGRAM_USERID` must initiate a conversation with this bot (e.g., by sending `/start`) before it can send them private messages.

### 2. ElizaOS Agent Character Configuration

In your agent's character definition file (e.g., `src/index.ts` or similar), configure the agent to use this plugin and provide necessary settings:

```typescript
import type {
  Character,
  IAgentRuntime,
  Project,
  ProjectAgent,
} from "@elizaos/core";
import pingPalGitHubPlugin from "plugin-pingpal-github"; // Assuming the plugin is correctly referenced

export const character: Character = {
  name: "GitHub Monitor Agent",
  plugins: [
    "@elizaos/plugin-sql", // Required for memory (deduplication)
    "@elizaos/plugin-telegram", // Required for sending notifications
    "plugin-pingpal-github", // This plugin
  ],
  settings: {
    // Secrets can reference environment variables
    // These ensure ElizaOS securely manages them and makes them available via runtime.getSetting()
    GITHUB_ACCESS_TOKEN: process.env.GITHUB_ACCESS_TOKEN,
    TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY, // Or your LLM provider key

    // PingPal GitHub Plugin specific settings
    pingpal: {
      targetGitHubUsername: process.env.PINGPAL_TARGET_GITHUB_USERNAME,
      targetTelegramUserId: process.env.PINGPAL_TARGET_TELEGRAM_USERID,
    },
  },
  // Other character properties (bio, style, etc.)
};

export const projectAgent: ProjectAgent = {
  character,
  init: async (runtime: IAgentRuntime) => {
    console.log("Initializing GitHub Monitor Agent:", character.name);
    // Agent-specific initialization if any
  },
  plugins: [pingPalGitHubPlugin], // Ensure the plugin instance is added here
  tests: [],
};

const project: Project = {
  agents: [projectAgent],
};

export default project;
```

## Running the Plugin

1.  **Install Dependencies:** Ensure all dependencies for your ElizaOS project and this plugin are installed (`npm install` or `bun install`).
2.  **Configure:** Set up your `.env` file and character configuration as described above.
3.  **Start ElizaOS:** Run your ElizaOS agent that includes this plugin.
    ```bash
    npx elizaos start
    # or if you have it as a script in package.json
    # npm run start / bun run start
    ```
4.  **Test:** Create activity on your GitHub account (e.g., mention yourself in an issue, request a review, assign an issue).
    - Check the agent's console logs for GitHub API polling status, notification detection, and LLM analysis logs.
    - If a notification is deemed important by the LLM, you should receive a notification on the configured Telegram account.

## Development

```bash
# Start development with hot-reloading
bun run dev

# Build the plugin
bun run build

# Test the plugin
bun test

# Format code
bun run format
```

## Notification Types Monitored

The plugin specifically monitors the following GitHub notification types:

- **mention**: You were directly mentioned in an issue or pull request
- **review_requested**: Your review was requested on a pull request
- **assign**: You were assigned to an issue or pull request
- **author**: Activity on issues or pull requests you authored

## Agent Configuration (in package.json - for plugin registry)

The `agentConfig` section in this plugin's `package.json` defines the parameters your plugin requires for users to discover it through the registry. This is less about runtime and more about discovery and informing users about necessary settings.

Example configuration:

```json
"agentConfig": {
  "pluginType": "elizaos:plugin:1.0.0",
  "pluginParameters": {
    "pingpal.targetGitHubUsername": {
      "type": "string",
      "description": "The GitHub username whose notifications should be monitored."
    },
    "pingpal.targetTelegramUserId": {
      "type": "string",
      "description": "The numerical Telegram User ID to send notifications to."
    }
    // Note: GitHub access token, Telegram Bot Token, and LLM API keys are typically configured
    // as secrets at the agent level, not directly as pluginParameters here,
    // as they are sensitive and often shared across an agent's plugins.
    // The plugin relies on these being available via process.env.
  }
}
```

## How Importance Analysis Works

The LLM analyzes each GitHub notification based on:

- Direct mentions requiring response
- Pull request review requests needing timely action
- Issue assignments requiring work
- Critical discussions or blockers
- Deadlines or time-sensitive matters
- Tasks requiring immediate response

The analysis considers the notification type, repository, subject title, and update timestamp to determine if immediate attention is required.

## Deduplication Strategy

The plugin uses a database-first deduplication approach:

1. **Primary Check:** Database memories in the `pingpal_github_processed` table
2. **Secondary Cache:** In-memory set for performance optimization (limited to 1000 entries)
3. **Persistent Storage:** All processed notifications are logged to ensure deduplication survives restarts

This ensures that you won't receive duplicate Telegram notifications for the same GitHub notification, even if the agent restarts or the notification appears multiple times in the API response.

## License

This plugin is part of the ElizaOS project.
