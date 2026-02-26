// discord metadata the LLM needs about the current message context
export interface MessageContext {
  /** the sender's display name (nickname or global name) */
  displayName: string;
  /** the sender's Discord username */
  username: string;
  /** human-readable channel name (e.g. "#general") or "DM" */
  channelName: string;
  /** guild/server name, if applicable */
  guildName?: string | null;
  /** whether the message is a DM */
  isDM: boolean;
}
