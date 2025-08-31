import type { Plugin } from "@elizaos/core";
import {
  type Action,
  type ActionResult,
  type Content,
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
  type Provider,
  type ProviderResult,
  Service,
  type State,
  logger,
  type MessagePayload,
  type WorldPayload,
  EventType,
  type UUID,
  stringToUuid,
  ChannelType,
} from "@elizaos/core";
import { z } from "zod";
import { pollGitHubNotificationsAction } from "./actions/pollGitHubNotifications";
import { analyzeGitHubNotificationAction } from "./actions/analyzeGitHubNotification";
import { sendTelegramNotificationAction } from "./actions/sendTelegramNotification";

/**
 * Generates a consistent internal room ID for the agent following the email plugin pattern
 */
const getInternalRoomIdForAgent = (agentId: UUID): UUID => {
  // Take first 13 chars of agentId to create a unique suffix (following email plugin pattern)
  const agentSpecificRoomSuffix = agentId.slice(0, 13);

  // Use stringToUuid with a clean, short seed string for proper UUID generation
  return stringToUuid(`pingpal-github-internal-room-${agentSpecificRoomSuffix}`);
};

/**
 * Defines the configuration schema for a plugin, including the validation rules for the plugin name.
 *
 * @type {import('zod').ZodObject<{ EXAMPLE_PLUGIN_VARIABLE: import('zod').ZodString }>}
 */
const configSchema = z.object({
  EXAMPLE_PLUGIN_VARIABLE: z
    .string()
    .min(1, "Example plugin variable is not provided")
    .optional()
    .transform((val) => {
      if (!val) {
        logger.warn(
          "Example plugin variable is not provided (this is expected)",
        );
      }
      return val;
    }),
});

/**
 * Example HelloWorld action
 * This demonstrates the simplest possible action structure
 */
/**
 * Action representing a hello world message.
 * @typedef {Object} Action
 * @property {string} name - The name of the action.
 * @property {string[]} similes - An array of related actions.
 * @property {string} description - A brief description of the action.
 * @property {Function} validate - Asynchronous function to validate the action.
 * @property {Function} handler - Asynchronous function to handle the action and generate a response.
 * @property {Object[]} examples - An array of example inputs and expected outputs for the action.
 */
const helloWorldAction: Action = {
  name: "HELLO_WORLD",
  similes: ["GREET", "SAY_HELLO"],
  description: "Responds with a simple hello world message",

  validate: async (
    _runtime: IAgentRuntime,
    _message: Memory,
    _state: State | undefined,
  ): Promise<boolean> => {
    // Always valid
    return true;
  },

  handler: async (
    _runtime: IAgentRuntime,
    message: Memory,
    _state: State | undefined,
    _options: Record<string, unknown> = {},
    callback?: HandlerCallback,
    _responses?: Memory[],
  ): Promise<ActionResult> => {
    try {
      logger.info("Handling HELLO_WORLD action");

      // Simple response content for callback
      const responseContent: Content = {
        text: "hello world!",
        actions: ["HELLO_WORLD"],
        source: message.content.source,
      };

      // Call back with the hello world message if callback is provided
      if (callback) {
        await callback(responseContent);
      }

      // Return ActionResult
      return {
        text: "hello world!",
        success: true,
        data: {
          actions: ["HELLO_WORLD"],
          source: message.content.source,
        },
      };
    } catch (error) {
      logger.error("Error in HELLO_WORLD action:", error);
      return {
        success: false,
        error: error instanceof Error ? error : new Error(String(error)),
      };
    }
  },

  examples: [
    [
      {
        name: "{{name1}}",
        content: {
          text: "Can you say hello?",
        },
      },
      {
        name: "{{name2}}",
        content: {
          text: "hello world!",
          actions: ["HELLO_WORLD"],
        },
      },
    ],
  ],
};

/**
 * Example Hello World Provider
 * This demonstrates the simplest possible provider implementation
 */
const helloWorldProvider: Provider = {
  name: "HELLO_WORLD_PROVIDER",
  description: "A simple example provider",

  get: async (
    _runtime: IAgentRuntime,
    _message: Memory,
    _state: State | undefined,
  ): Promise<ProviderResult> => {
    return {
      text: "I am a provider",
      values: {},
      data: {},
    };
  },
};

export class StarterService extends Service {
  static override serviceType = "starter";

  override capabilityDescription =
    "This is a starter service which is attached to the agent through the starter plugin.";

  constructor(runtime: IAgentRuntime) {
    super(runtime);
  }

  static override async start(runtime: IAgentRuntime): Promise<Service> {
    logger.info("Starting starter service");
    
    // Generate agent-specific internal room ID following email plugin pattern
    const internalRoomId = getInternalRoomIdForAgent(runtime.agentId);

    console.log(
      `[PingPal GitHub] Using internal room ID: ${internalRoomId}`,
    );

    // Ensure the internal room exists in the database (moved from init to start)
    await runtime.ensureRoomExists({
      id: internalRoomId,
      name: `PingPal GitHub Internal Logs - Agent ${runtime.agentId.slice(0, 8)}`,
      source: "internal_pingpal_github_plugin",
      type: ChannelType.SELF,
      worldId: runtime.agentId, // Use agentId as worldId for internal rooms
    });

    console.log(
      `[PingPal GitHub] Ensured internal room exists: ${internalRoomId}`,
    );

    // Set up periodic polling (every 30 seconds)
    const pollInterval = 30 * 1000; // 30 seconds
    setInterval(async () => {
      try {
        // Create a memory object for internal polling trigger
        // Use agent-specific internal roomId to avoid FK constraints
        const pollingMemory: Memory = {
          id: crypto.randomUUID(),
          entityId: runtime.agentId,
          roomId: internalRoomId, // Use agent-specific room ID
          agentId: runtime.agentId,
          content: { text: "Polling GitHub notifications", source: "internal" },
          createdAt: Date.now(),
        };

        // Execute the polling action directly
        if (
          await pollGitHubNotificationsAction.validate(runtime, pollingMemory)
        ) {
          await pollGitHubNotificationsAction.handler(runtime, pollingMemory);
        }
      } catch (error) {
        logger.error("[PingPal GitHub] Error during periodic polling:", error);
      }
    }, pollInterval);

    console.log(
      "[PingPal GitHub] Registered periodic GitHub notification polling (30 second intervals).",
    );

    const service = new StarterService(runtime);
    return service;
  }

  static override async stop(runtime: IAgentRuntime): Promise<void> {
    logger.info("Stopping starter service");
    const service = runtime.getService(StarterService.serviceType);
    if (!service) {
      throw new Error("Starter service not found");
    }
    if ("stop" in service && typeof service.stop === "function") {
      await service.stop();
    }
  }

  override async stop(): Promise<void> {
    logger.info("Starter service stopped");
  }
}

export const pingPalGitHubPlugin: Plugin = {
  name: "pingpal-github",
  description:
    "Monitors GitHub notifications and sends important ones via Telegram.",
  config: {
    EXAMPLE_PLUGIN_VARIABLE: process.env.EXAMPLE_PLUGIN_VARIABLE,
  },
  async init(config: Record<string, string>, _runtime: IAgentRuntime) {
    console.log("Initializing PingPal GitHub Plugin....");

    // Validate required configuration
    const accessToken = process.env.GITHUB_ACCESS_TOKEN;
    const targetUsername = process.env.PINGPAL_TARGET_GITHUB_USERNAME;
    const targetTelegramUserId = process.env.PINGPAL_TARGET_TELEGRAM_USERID;

    if (!accessToken) {
      throw new Error("GITHUB_ACCESS_TOKEN environment variable is required");
    }
    if (!targetUsername) {
      throw new Error(
        "PINGPAL_TARGET_GITHUB_USERNAME environment variable is required",
      );
    }
    if (!targetTelegramUserId) {
      throw new Error(
        "PINGPAL_TARGET_TELEGRAM_USERID environment variable is required",
      );
    }

    console.log(
      `[PingPal GitHub] Configured to monitor GitHub notifications for user: ${targetUsername}`,
    );
    console.log(
      `[PingPal GitHub] Will send alerts to Telegram user: ${targetTelegramUserId}`,
    );

    try {
      const validatedConfig = await configSchema.parseAsync(config);

      // Set all environment variables at once
      for (const [key, value] of Object.entries(validatedConfig)) {
        if (value) process.env[key] = value;
      }
    } catch (error) {
      if (error instanceof z.ZodError) {
        throw new Error(
          `Invalid plugin configuration: ${error.errors.map((e) => e.message).join(", ")}`,
        );
      }
      throw error;
    }

    // Room creation and polling setup moved to StarterService.start() to avoid timing issues
  },
  models: {
    // Remove the placeholder models to let ElizaOS use its default model implementations
  },
  routes: [
    {
      name: "api-status",
      path: "/api/status",
      type: "GET",
      handler: async (_req: any, res: any) => {
        res.json({
          status: "ok",
          plugin: "quick-starter",
          timestamp: new Date().toISOString(),
        });
      },
    },
  ],
  events: {
    [EventType.MESSAGE_RECEIVED]: [
      async (params: MessagePayload) => {
        logger.debug("MESSAGE_RECEIVED event received");
        logger.debug("Message:", params.message);
      },
    ],
    [EventType.VOICE_MESSAGE_RECEIVED]: [
      async (params: MessagePayload) => {
        logger.debug("VOICE_MESSAGE_RECEIVED event received");
        logger.debug("Message:", params.message);
      },
    ],
    [EventType.WORLD_CONNECTED]: [
      async (params: WorldPayload) => {
        logger.debug("WORLD_CONNECTED event received");
        logger.debug("World:", params.world);
      },
    ],
    [EventType.WORLD_JOINED]: [
      async (params: WorldPayload) => {
        logger.debug("WORLD_JOINED event received");
        logger.debug("World:", params.world);
      },
    ],
  },
  services: [StarterService],
  actions: [
    pollGitHubNotificationsAction,
    analyzeGitHubNotificationAction,
    sendTelegramNotificationAction,
  ],
  providers: [helloWorldProvider],
  dependencies: ['@elizaos/plugin-telegram'], // Required for sending Telegram notifications
};

export default pingPalGitHubPlugin;
