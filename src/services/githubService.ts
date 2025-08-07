import { logger } from "@elizaos/core";

export interface GitHubNotification {
  id: string;
  thread: {
    id: string;
    url: string;
  };
  subject: {
    title: string;
    url: string | null;
    latest_comment_url: string | null;
    type: string; // "Issue", "PullRequest", etc.
  };
  reason: string; // "mention", "review_requested", "assign", etc.
  repository: {
    id: number;
    name: string;
    full_name: string;
    html_url: string;
  };
  updated_at: string;
  last_read_at: string | null;
  url: string;
}

export class GitHubService {
  private accessToken: string;
  private baseUrl = "https://api.github.com";

  constructor(accessToken: string) {
    this.accessToken = accessToken;
  }

  async getNotifications(): Promise<GitHubNotification[]> {
    try {
      const response = await fetch(`${this.baseUrl}/notifications`, {
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          Accept: "application/vnd.github+json",
          "User-Agent": "PingPal-GitHub-Monitor",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      });

      if (!response.ok) {
        throw new Error(
          `GitHub API error: ${response.status} ${response.statusText}`,
        );
      }

      const notifications: GitHubNotification[] = await response.json();
      logger.debug(
        { count: notifications.length },
        "[PingPal GitHub] Retrieved notifications from GitHub API",
      );

      return notifications;
    } catch (error) {
      logger.error(
        { error },
        "[PingPal GitHub] Failed to fetch notifications from GitHub API",
      );
      throw error;
    }
  }

  async markNotificationAsRead(notificationId: string): Promise<void> {
    try {
      await fetch(`${this.baseUrl}/notifications/threads/${notificationId}`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          Accept: "application/vnd.github+json",
          "User-Agent": "PingPal-GitHub-Monitor",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      });
    } catch (error) {
      logger.warn(
        { error, notificationId },
        "[PingPal GitHub] Failed to mark notification as read",
      );
    }
  }
}
