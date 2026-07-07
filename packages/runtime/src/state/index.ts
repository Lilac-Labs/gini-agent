// Barrel re-export. Mirrors the public surface of the previous
// monolithic src/state.ts so importers can keep `from "../state"` /
// `from "./state"` paths unchanged. Add a new name here when promoting
// an internal helper to public; everything that was exported before the
// split must remain re-exported here.

export { now, id } from "./ids";
export { assertInsideWorkspace, assertInsideWorkspaceNoSymlinkEscape } from "./security";
export {
  createEmptyState,
  readState,
  writeState,
  mutateState,
  seedDefaultAgentFromRuntimeConfig,
  isTerminalTaskStatus
} from "./store";
export { appendTrace, readTrace, tracePath, appendLog } from "./trace";
export { addAudit, appendEvent } from "./audit";
export { recordUsage, applyUsage, localDayKey, buildDailyUsage, backfillUsageLedger, backfillUsageLedgerOnce } from "./usage";
export type { DayUsage, DaySourceUsage } from "./usage";
export { recordProviderAuthFailure, clearProviderAuthFailureIfPresent } from "./provider-auth";
export {
  getMemoryDb,
  closeMemoryDb,
  closeAllMemoryDbs,
  removeMemoryDb,
  ensureDefaultBank,
  ensureAgentBank,
  bankIdForAgent,
  deleteBankAndUnits,
  insertMemoryUnit,
  getMemoryUnit,
  countMemoryUnits,
  countByNetwork,
  countUnitsByEmbeddingModel,
  updateMemoryUnitEmbedding,
  insertEntity,
  linkUnitToEntity,
  insertLink,
  linksFrom,
  linksFromMany,
  listBanks,
  listMemoryUnits,
  recentMemoryUnitIds,
  unitsForEntity,
  upsertObservationUnit,
  updateMemoryUnitConfidence,
  updateMemoryUnitStats,
  findEntitiesByMentions,
  entityMentionsForUnit,
  getBank,
  updateBank,
  probeMemoryDb,
  serializeEmbedding,
  deserializeEmbedding,
  memoryDbPath,
  DEFAULT_BANK_ID,
  MEMORY_SCHEMA_VERSION
} from "./memory-db";
export type {
  MemoryBank,
  MemoryUnit as HindsightMemoryUnit,
  MemoryLink as HindsightMemoryLink,
  Entity as HindsightEntity,
  EntityMention,
  Network,
  LinkType,
  CausalSubtype,
  EntityType,
  MemoryUnitStatus,
  NetworkCounts,
  EmbeddingModelCount,
  MemoryDbProbe,
  InsertMemoryUnitInput,
  InsertEntityInput,
  InsertLinkInput,
  ListUnitsOptions,
  UpdateUnitStatsOptions,
  UpdateBankInput
} from "./memory-db";
export {
  getAgentDataDb,
  agentDataDbPath,
  closeAgentDataDb,
  closeAllAgentDataDbs,
  dbQuery,
  dbExecute,
  dbListTables,
  AgentDataError,
  MAX_RESULT_ROWS
} from "./agent-data-db";
export type { QueryResult, ExecuteResult, TableInfo } from "./agent-data-db";
export {
  storeUpload,
  readUpload,
  uploadExists,
  uploadStat,
  uploadPathFor,
  isPlausibleMime,
  sanitizeFilename
} from "./uploads";
export {
  insertChatBlock,
  attachTaskToUserTextBlock,
  upsertAssistantTextBlock,
  updateToolCallBlock,
  listChatBlocks,
  listChatBlocksAfter,
  listThreadBlocks,
  getMainChatUserTextBlockForTask,
  getMainChatBlock,
  summarizeThreads,
  summarizeThreadsForInstance,
  deleteChatBlocksForSession,
  deleteChatBlock,
  findInFlightAssistantTextForTask,
  healOrphanedStreamingBlocks,
  taskProducedAssistantText,
  latestAssistantTextForSession,
  latestAssistantTextForThread,
  getLatestMessagesBySession,
  subscribeChatBlocks,
  subscribeAllChatBlocks
} from "./chat-blocks";
export type { InsertChatBlockInput } from "./chat-blocks";
export {
  upsertDevice,
  listDevicesForCredential,
  listAllDevices,
  getDevice,
  removeDevice,
  removeDeviceForCredential
} from "./devices";
export type { PushDevice, UpsertDeviceInput, DeviceOrigin } from "./devices";
export {
  addSseSubscription,
  isDeviceWatching,
  hasAnyActiveSubscription,
  clearDeviceWatch,
  clearSessionWatch,
  clearStreamWatch,
  addPushlessSubscription,
  isSessionWebWatched
} from "./sse-subscriptions";
export {
  subscribeChatSession,
  publishChatSession
} from "./chat-session-events";
export {
  buildContainerAttentionIndex,
  deriveContainerAttention,
  latestRunOutcome
} from "./attention";
export type { ContainerAttentionIndex, ContainerRunOutcome } from "./attention";
export {
  markRead,
  markUnread,
  markForwardedTopicsRead,
  clearReadState,
  getLastReadByDevice,
  getReadState,
  unreadCountForDevice,
  unreadCountsByDevice
} from "./chat-read-state";
export type { ChatReadState } from "./chat-read-state";
export {
  taskCounts,
  upsertTask,
  appendTaskPartial,
  createTask,
  createRun,
  createPlanStep,
  createChatSession,
  createTopic,
  createTaskContainer,
  acknowledgeContainer,
  setContainerArchived,
  setContainerPinned,
  findChildContainerByCorrelationKey,
  deleteChatSession,
  renameChatSession,
  enqueuePendingChatMessage,
  removePendingChatMessage,
  shiftPendingChatMessage,
  sessionHasInFlightChatTask,
  createChatMessage,
  createAuthorization,
  createSetupRequest,
  createSkill,
  createJob,
  createJobRun,
  createImprovementProposal,
  createSkillOutcome,
  createLearningFinding,
  createPromotionProposal,
  decidePromotion,
  createSnapshotRecord,
  createSubagentRecord,
  createMcpServerRecord,
  createMessagingBridgeRecord,
  buildMessagingBridgeRecord,
  createMessagingMessageRecord,
  findOrCreateTelegramChatSession,
  findOrCreateDiscordChatSession,
  createImportReport,
  createAgentRecord,
  createRelayRecord,
  createTunnelRecord,
  createNotificationRecord,
  activateAgent,
  updateConnectorHealth
} from "./records";
export {
  createEmailWatcher,
  addEmailWatcher,
  buildWatcherQuery,
  listEmailWatchers,
  getEmailWatcher,
  updateEmailWatcher,
  setEmailWatcherEnabled,
  setEmailTriageEnabled,
  setEmailWatcherObjective,
  clearEmailWatcherObjective,
  validateObjective,
  validateThreadId,
  removeEmailWatcher,
  backfillEmailWatcherJobs
} from "./email-watchers";
export type { AddEmailWatcherInput } from "./email-watchers";
