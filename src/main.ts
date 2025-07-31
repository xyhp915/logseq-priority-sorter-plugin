import "@logseq/libs";

/*
 * Logseq Priority Sorter – TypeScript entry
 * (Type guards + casting to satisfy @logseq/libs TS defs)
 */

// ---------------------------------------------------------------------------
// Minimal local types (loose; avoid deep SDK imports to keep build simple)
// ---------------------------------------------------------------------------
interface BlockLike {
  uuid: string;
  content?: string | null;
  children?: BlockLike[] | null;
  [k: string]: unknown;
}
interface CycleState {
  updating: boolean;
  queuedDir: -1 | 0 | 1;
}

// ---------------------------------------------------------------------------
// Common definitions
// ---------------------------------------------------------------------------
const PRIORITY_CYCLE = ["[#A]", "[#B]", "[#C]"];

const cycleStateMap: Map<string, CycleState> = new Map();

// Task state keywords seen in Logseq workflows & community usage
const TASK_PREFIX_RE =
  /^(TODO|DOING|DONE|CANCELLED|CANCELED|WAITING|WAIT|IN[-_]?PROGRESS|HOLD|NEXT|NOW|LATER)\s+/i;
// Priority token at head (single)
const PRIORITY_HEAD_RE = /^\s*\[#([ABC])\]\s*/i;
// Any priority tokens anywhere (for cleanup)
const STRIP_PRIORITY_G = /\s*\[#([ABC])\]\s*/gi;

// ---------------------------------------------------------------------------
// Small TS helpers
// ---------------------------------------------------------------------------
type MsgType = "success" | "warning" | "error" | "info";
function appShowMsg(msg: string, type: MsgType = "info"): void {
  const ls: any = logseq as any;
  if (ls?.UI?.showMsg) {
    ls.UI.showMsg(msg, type);
    return;
  }
  if (ls?.App?.showMsg) {
    ls.App.showMsg(msg, type);
    return;
  }
  console.log(`[LogseqMsg:${type}]`, msg);
}

async function getCurrentPageName(): Promise<string | null> {
  const page: any = await logseq.Editor.getCurrentPage();
  if (!page) return null;
  return page.name ?? page.originalName ?? page.id ?? null;
}

async function getChildren(uuid: string): Promise<BlockLike[]> {
  const full: any = await logseq.Editor.getBlock(uuid, { includeChildren: true });
  const children = full?.children;
  return Array.isArray(children) ? (children as BlockLike[]) : [];
}

function detectPriorityIndex(content: string | null | undefined): number {
  if (!content) return -1;
  const m = content.match(/\[#([ABC])\]/i);
  if (!m) return -1;
  const token = `[#${m[1].toUpperCase()}]`;
  const idx = PRIORITY_CYCLE.indexOf(token);
  return idx === -1 ? -1 : idx;
}

function getPriorityRank(content: string | null | undefined): number {
  const idx = detectPriorityIndex(content);
  return idx === -1 ? PRIORITY_CYCLE.length : idx;
}

// ===========================================================================
// Cycle Priority
// ===========================================================================
export async function cyclePriority(direction: -1 | 1 = 1): Promise<void> {
  try {
    const block = (await logseq.Editor.getCurrentBlock()) as any;
    if (!block) return;
    await _cyclePriorityForUuid(block.uuid, direction, block as BlockLike);
  } catch (e: any) {
    console.error("cyclePriority top-level error", e);
    appShowMsg("⚠️ Cycle error: " + (e.message || e), "error");
  }
}

async function _cyclePriorityForUuid(
  uuid: string,
  direction: -1 | 1,
  preFetchedBlock?: BlockLike | null,
): Promise<void> {
  const st = cycleStateMap.get(uuid) || { updating: false, queuedDir: 0 };
  if (st.updating) {
    st.queuedDir = direction;
    cycleStateMap.set(uuid, st);
    return;
  }
  st.updating = true;
  st.queuedDir = 0;
  cycleStateMap.set(uuid, st);

  try {
    const block =
      preFetchedBlock ||
      ((await logseq.Editor.getBlock(uuid)) as unknown as BlockLike | null);
    if (!block) throw new Error("Block not found");
    let content = block.content ?? "";

    // 1) Extract leading task keyword
    const mTask = content.match(TASK_PREFIX_RE);
    let prefix = "";
    let body = content;
    if (mTask) {
      prefix = mTask[0];
      body = body.slice(mTask[0].length);
    }

    // 2) Extract existing head priority
    const mHead = body.match(PRIORITY_HEAD_RE);
    let curIndex: number;
    if (mHead) {
      const headToken = `[#${mHead[1].toUpperCase()}]`;
      curIndex = PRIORITY_CYCLE.indexOf(headToken);
      body = body.slice(mHead[0].length);
    } else {
      // タグがなければ必ず「未設定」扱い（-1 → A）
      curIndex = -1;
    }

    // 3) Cleanup stray tokens
    body = body.replace(STRIP_PRIORITY_G, " ");

    // 4) Compute next index
    const len = PRIORITY_CYCLE.length;
    const nextIndex = (curIndex + direction + len) % len;

    // 5) Rebuild content
    body = body.replace(/\s{2,}/g, " ").trimStart();
    const sep = body.length ? " " : "";
    await logseq.Editor.updateBlock(
      uuid,
      prefix + PRIORITY_CYCLE[nextIndex] + sep + body,
    );
  } catch (e: any) {
    console.error("_cyclePriorityForUuid error", e);
    appShowMsg("⚠️ Cycle error: " + (e.message || e), "error");
  } finally {
    const st2 = cycleStateMap.get(uuid) || { updating: true, queuedDir: 0 };
    st2.updating = false;
    cycleStateMap.set(uuid, st2);
  }

  const queued = cycleStateMap.get(uuid)?.queuedDir ?? 0;
  if (queued) {
    cycleStateMap.set(uuid, { updating: false, queuedDir: 0 });
    await _cyclePriorityForUuid(uuid, queued);
  }
}

// ===========================================================================
// Sort: Page Top-Level
// ===========================================================================
export async function sortByPriority(): Promise<void> {
  try {
    const pageName = await getCurrentPageName();
    if (!pageName || pageName === "Journal") {
      appShowMsg("⚠️ Priority sorting is only available on regular pages", "warning");
      return;
    }

    const tree = (await logseq.Editor.getPageBlocksTree(pageName)) as any[];
    if (!tree || tree.length < 2) {
      appShowMsg("⚠️ Not enough items to sort (need at least 2)", "warning");
      return;
    }

    const items = tree.map((b) => ({ uuid: b.uuid, content: b.content || "" }));
    items.sort((a, b) => getPriorityRank(a.content) - getPriorityRank(b.content));
    const sortedUuids = items.map((o) => o.uuid);

    for (let i = 0; i < sortedUuids.length; i++) {
      const u = sortedUuids[i];
      const target = i === 0 ? sortedUuids[1] : sortedUuids[i - 1];
      if (!target) break;
      await logseq.Editor.moveBlock(u, target, { before: i === 0 });
    }

    appShowMsg("✅ Page sorted by priority successfully", "success");
  } catch (e: any) {
    console.error("sortByPriority error", e);
    appShowMsg("❌ Sort error: " + (e.message || e), "error");
  }
}

// ===========================================================================
// Sort: Children of Current Block
// ===========================================================================
export async function sortChildrenByPriority(): Promise<void> {
  try {
    const parent = (await logseq.Editor.getCurrentBlock()) as any;
    if (!parent) {
      appShowMsg("⚠️ Failed to retrieve parent block", "warning");
      return;
    }

    const children = await getChildren(parent.uuid);
    if (children.length < 2) {
      appShowMsg("⚠️ Not enough child blocks to sort (need at least 2)", "warning");
      return;
    }

    const items = children.map((b) => ({ uuid: b.uuid, content: b.content || "" }));
    items.sort((a, b) => getPriorityRank(a.content) - getPriorityRank(b.content));
    const sortedUuids = items.map((o) => o.uuid);

    for (let i = 0; i < sortedUuids.length; i++) {
      const u = sortedUuids[i];
      const target = i === 0 ? sortedUuids[1] : sortedUuids[i - 1];
      if (!target) break;
      await logseq.Editor.moveBlock(u, target, { before: i === 0 });
    }

    appShowMsg(
      "✅ Child blocks sorted by priority successfully",
      "success",
    );
  } catch (e: any) {
    console.error("sortChildrenByPriority error", e);
    appShowMsg("❌ Children sort error: " + (e.message || e), "error");
  }
}

// ===========================================================================
// main() registration
// ===========================================================================
function main(): void {
  console.log("🚀 Priority Sorter initialized");

  logseq.App.registerCommandPalette(
    { key: "priority-cycle", label: "Priority: Cycle" },
    () => cyclePriority(1),
  );
  logseq.Editor.registerSlashCommand("priority-cycle", () => cyclePriority(1));
  logseq.App.registerCommandShortcut(
    { binding: "alt+mod+right" },
    () => cyclePriority(1),
  );

  logseq.App.registerCommandPalette(
    { key: "priority-sort-page", label: "Priority: Sort Page" },
    sortByPriority,
  );
  logseq.Editor.registerSlashCommand("priority-sort-page", sortByPriority);
  logseq.App.registerCommandShortcut(
    { binding: "alt+mod+up" },
    sortByPriority,
  );

  logseq.App.registerCommandPalette(
    { key: "priority-sort-children", label: "Priority: Sort Children" },
    sortChildrenByPriority,
  );
  logseq.Editor.registerSlashCommand(
    "priority-sort-children",
    sortChildrenByPriority,
  );
  logseq.App.registerCommandShortcut(
    { binding: "alt+mod+down" },
    sortChildrenByPriority,
  );
}

logseq.ready(main).catch(console.error);
