import type { ChatBlock, ToolResultBlock } from "@runtime/types";
import { BlockAuthorizationRequested } from "./BlockAuthorizationRequested";
import { BlockSetupRequested } from "./BlockSetupRequested";
import { BlockAssistantText } from "./BlockAssistantText";
import { BlockPhase } from "./BlockPhase";
import { BlockSystemNote } from "./BlockSystemNote";
import { BlockToolCall } from "./BlockToolCall";
import { BlockUserText } from "./BlockUserText";
import { RoutineCreatedCard } from "./RoutineCreatedCard";
import { TopicForwardChip } from "./TopicForwardChip";
import { rendersAsRoutineCard } from "@/lib/group-exchanges";
import { assertNever } from "@/lib/utils";

// Dispatcher for the typed ChatBlock union. The switch is exhaustive on
// `block.kind` — adding a new block kind requires a new case here, and
// the `never` guard in the default branch makes the compiler enforce it.
//
// Tool results don't render as standalone rows — they're shown inline
// when the user expands their parent tool_call. The page resolves the
// callId → tool_result mapping and passes the matching result here.
export function BlockRenderer({
  block,
  toolResult,
  agent,
  isFinalAnswer
}: {
  block: ChatBlock;
  toolResult?: ToolResultBlock;
  agent?: { id: string; name: string };
  // True only for the turn's closing answer (see ChatRenderItem). A forwarded
  // Topic turn mirrors its per-iteration narration as assistant_text too, so the
  // "# topic" chip is shown only on the final answer — not under every thinking
  // line — by gating the chip on this flag.
  isFinalAnswer?: boolean;
}) {
  switch (block.kind) {
    case "user_text":
      return <BlockUserText block={block} />;
    case "assistant_text":
      // A forwarded Topic answer carries its source Topic; render a deep-link
      // chip under the answer text, aligned to the message in the avatar gutter.
      return block.forwardedFromTopicId && isFinalAnswer ? (
        <div className="space-y-2">
          <BlockAssistantText block={block} agent={agent} />
          <div className="pl-[46px]">
            <TopicForwardChip
              topicId={block.forwardedFromTopicId}
              topicTitle={block.forwardedFromTopicTitle}
            />
          </div>
        </div>
      ) : (
        <BlockAssistantText block={block} agent={agent} />
      );
    case "tool_call":
      // A successful create_job renders as the standalone routine card (the
      // grouping in lib/group-exchanges.ts already keeps it out of the
      // collapsed tool group); every other call keeps the generic tool row.
      return rendersAsRoutineCard(block) ? (
        <RoutineCreatedCard block={block} />
      ) : (
        <BlockToolCall block={block} result={toolResult} />
      );
    case "tool_result":
      return null;
    case "phase":
      return <BlockPhase block={block} />;
    case "authorization_requested":
      // A gate forwarded from a Topic carries its source Topic; render the same
      // deep-link chip under the (fully actionable) card, aligned like the
      // assistant_text chip above.
      return block.forwardedFromTopicId ? (
        <div className="space-y-2">
          <BlockAuthorizationRequested block={block} />
          <div className="pl-[46px]">
            <TopicForwardChip
              topicId={block.forwardedFromTopicId}
              topicTitle={block.forwardedFromTopicTitle}
            />
          </div>
        </div>
      ) : (
        <BlockAuthorizationRequested block={block} />
      );
    case "setup_requested":
      // `agent` names the chat.choice question bubble (it renders as the
      // agent speaking); the other setup cards ignore it.
      return block.forwardedFromTopicId ? (
        <div className="space-y-2">
          <BlockSetupRequested block={block} agent={agent} />
          <div className="pl-[46px]">
            <TopicForwardChip
              topicId={block.forwardedFromTopicId}
              topicTitle={block.forwardedFromTopicTitle}
            />
          </div>
        </div>
      ) : (
        <BlockSetupRequested block={block} agent={agent} />
      );
    case "system_note":
      return <BlockSystemNote block={block} />;
    default:
      return assertNever(block);
  }
}
