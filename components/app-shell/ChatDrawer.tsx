"use client";

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import {
  Activity,
  AlertTriangle,
  Bot,
  BookOpen,
  Bug,
  Check,
  ChevronDown,
  ChevronUp,
  Clock,
  FilePlus,
  GitBranch,
  GitMerge,
  GitPullRequest,
  Globe,
  Layers,
  Loader2,
  MessageSquare,
  Plus,
  Rocket,
  RotateCcw,
  Search,
  Send,
  ShieldCheck,
  Sparkles,
  Trash2,
  UserRound,
  X,
  Zap
} from "lucide-react";
import { SpecCitation, isSpecId } from "@/components/ui/SpecCitation";
import { InputModal } from "@/components/ui/InputModal";

type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  responseSource?: string | null;
};

type ChatThread = {
  id: string;
  title: string;
  channel: "web" | "telegram";
  messageCount: number;
  lastMessage?: string | null;
  lastMessageRole?: string | null;
  updated_at: string;
};

type ActionOption = {
  label: string;
  sublabel?: string;
  /** Message text auto-sent when the user clicks this chip */
  value: string;
  badge?: string;
};

type ChatAction = {
  type: string;
  status: "pending_confirmation" | "executing" | "completed" | "failed" | "needs_input";
  params: Record<string, any>;
  missingParams?: string[];
  confirmationMessage?: string;
  result?: any;
  error?: string;
  /** Selectable option chips returned by the backend */
  options?: ActionOption[];
};

type RecipeOption = {
  id: string;
  label: string;
  prefix: string;
  heading?: string | null;
  baseBranch?: string | null;
  sourceBranch?: string | null;
  isSample?: boolean;
};

type ChatDrawerProps = {
  open: boolean;
  onClose: () => void;
};

type QuickPrompt = {
  id: string;
  label: string;
  prompt: string;
  Icon: React.ComponentType<{ size?: number | string }>;
  category: "info" | "deploy" | "release" | "incident" | "pr";
};

const quickPrompts: QuickPrompt[] = [
  // ── Info / Read ──────────────────────────────────────────────────────
  { id: "pending_deployments", Icon: Clock,          category: "info",     label: "What's pending?",         prompt: "What's pending deployment?" },
  { id: "recent_prs",          Icon: GitPullRequest, category: "pr",       label: "My recent PRs",           prompt: "Show my recent PRs." },
  { id: "ci_status",           Icon: Activity,       category: "info",     label: "CI status",               prompt: "Show CI status." },
  { id: "release_pipeline",    Icon: Layers,         category: "release",  label: "Release pipeline",        prompt: "Show release trace status." },
  { id: "release_handbook",    Icon: BookOpen,       category: "release",  label: "Release handbook",        prompt: "Prepare a release handbook based on the recent production release." },
  { id: "active_incidents",    Icon: AlertTriangle,  category: "incident", label: "Active incidents",        prompt: "Show active incidents." },

  // ── PR & Spec ─────────────────────────────────────────────────────────
  { id: "create_draft_pr",     Icon: FilePlus,       category: "pr",       label: "Create Draft PR",         prompt: "Create Draft PR from a sample ticket." },
  { id: "create_release_pr",   Icon: GitBranch,      category: "release",  label: "Draft release PR",        prompt: "Create a release draft PR from develop to main." },

  // ── Deploy ────────────────────────────────────────────────────────────
  { id: "deploy_preview",      Icon: Rocket,         category: "deploy",   label: "Deploy to preview",       prompt: "Deploy my merged PR to preview." },
  { id: "redeploy_preview",    Icon: RotateCcw,      category: "deploy",   label: "Redeploy preview",        prompt: "Redeploy preview." },
  { id: "deploy_production",   Icon: Globe,          category: "deploy",   label: "Deploy to production",    prompt: "Deploy to production." },
  { id: "redeploy_release_tag", Icon: RotateCcw,      category: "deploy",   label: "Redeploy release tag",    prompt: "Redeploy my current release tag." },

  // ── Release ───────────────────────────────────────────────────────────
  { id: "rollback_production", Icon: RotateCcw,      category: "release",  label: "Rollback production",     prompt: "Rollback production to previous version." },

  // ── Incidents ─────────────────────────────────────────────────────────
  { id: "create_hotfix",       Icon: Bug,            category: "incident", label: "Create hotfix",           prompt: "Create a hotfix for the active incident." },
  { id: "approve_hotfix",      Icon: GitMerge,       category: "incident", label: "Approve hotfix",          prompt: "Approve and deploy the hotfix." },
  { id: "analyze_incident",    Icon: Search,         category: "incident", label: "Analyze incident",        prompt: "Analyze the active incident." },
  { id: "resolve_incident",    Icon: ShieldCheck,    category: "incident", label: "Resolve incident",        prompt: "Resolve the active incident." },
];

const welcomeMessage: ChatMessage = {
  id: "welcome",
  role: "assistant",
  content:
    "I'm ShipBrain AI. I can help you with PRs, deployments, releases, incidents, and more. Just ask me to perform an action or view your current status."
};

const selectedSpecRecipeStorageKey = "shipbrain:selected-spec-pr-recipe";

function stripInternalActionBlock(text: string): string {
  return text
    .replace(/```(?:text|plaintext)?\s*ACTION_DETECTED:[\s\S]*?MISSING:[^\n`]*(?:\n```)?/gi, "")
    .replace(/^ACTION_DETECTED:[\s\S]*?^MISSING:[^\n]*(?:\n\s*)?/gim, "")
    .trim();
}

// Mask sensitive information in messages
function maskSensitiveInfo(text: string): string {
  return stripInternalActionBlock(text)
    .replace(/([A-Za-z_]+_?(?:API_?)?KEY[=:\s]+)['"]?([A-Za-z0-9_\-]{20,})['"]?/gi, "$1****")
    .replace(/(sk-[A-Za-z0-9]{20,})/g, "sk-****")
    .replace(/(ghp_[A-Za-z0-9]{36,})/g, "ghp_****")
    .replace(/(github_pat_[A-Za-z0-9_]{20,})/g, "github_pat_****")
    .replace(/([Tt]oken[=:\s]+)['"]?([A-Za-z0-9_\-\.]{20,})['"]?/gi, "$1****")
    .replace(/([Pp]assword[=:\s]+)['"]?([^\s'"]{6,})['"]?/gi, "$1****")
    .replace(/([Ss]ecret[=:\s]+)['"]?([A-Za-z0-9_\-]{16,})['"]?/gi, "$1****")
    .replace(/(webhook[_\s]?secret[=:\s]+)['"]?([A-Za-z0-9_\-]{16,})['"]?/gi, "$1****");
}

function TypingIndicator() {
  return (
    <div className="chat-typing" role="status" aria-label="ShipBrain AI is typing">
      <i aria-hidden="true" />
      <i aria-hidden="true" />
      <i aria-hidden="true" />
    </div>
  );
}

function recipeBranchLabel(recipe: RecipeOption) {
  return recipe.sourceBranch ? `${recipe.sourceBranch} -> ${recipe.baseBranch ?? "develop"}` : recipe.baseBranch ?? "develop";
}

// Get action label for display
function getActionLabel(type: string): string {
  const labels: Record<string, string> = {
    spec_to_pr: "Create PR from Spec",
    deploy_preview: "Deploy to Preview",
    deploy_production: "Deploy to Production",
    approve_release: "Approve Release",
    rollback: "Rollback Release",
    create_hotfix: "Create Hotfix",
    approve_hotfix: "Approve Hotfix",
    analyze_incident: "Analyze Incident",
    resolve_incident: "Resolve Incident",
    acknowledge_incident: "Acknowledge Incident"
  };
  return labels[type] || type;
}

// Get risk level styling
function getRiskClass(type: string): string {
  const highRisk = ["deploy_production", "rollback", "approve_release", "approve_hotfix"];
  const mediumRisk = ["spec_to_pr", "deploy_preview", "create_hotfix", "resolve_incident", "acknowledge_incident"];
  if (highRisk.includes(type)) return "high-risk";
  if (mediumRisk.includes(type)) return "medium-risk";
  return "low-risk";
}

/**
 * During streaming the LLM outputs single `\n` newlines.
 * Markdown treats these as spaces (not paragraph breaks), so the text renders
 * as one continuous line until streaming is done.
 *
 * This normalizes content FOR DISPLAY ONLY during streaming:
 *  - Preserves existing \n\n paragraph breaks
 *  - Converts orphan \n (not inside a fenced code block) → \n\n
 *  - Does NOT touch ``` code blocks so indentation is preserved
 */
function normalizeMarkdown(text: string): string {
  // Split on fenced code blocks to avoid mangling them
  const segments = text.split(/(```[\s\S]*?(?:```|$))/g);
  return segments
    .map((segment, i) => {
      // Even indices are outside code fences, odd are inside
      if (i % 2 === 1) return segment;
      // Replace single \n (not already preceded/followed by \n) with \n\n
      return segment.replace(/([^\n])\n(?!\n)/g, "$1\n\n");
    })
    .join("");
}

export function ChatDrawer({ open, onClose }: ChatDrawerProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([welcomeMessage]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [hydrating, setHydrating] = useState(true);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [threads, setThreads] = useState<ChatThread[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [loadingThreads, setLoadingThreads] = useState(false);
  const [suggestionsExpanded, setSuggestionsExpanded] = useState(true);
  const [pendingAction, setPendingAction] = useState<ChatAction | null>(null);
  const [activeRepo, setActiveRepo] = useState<string | null>(null);
  const [showTagModal, setShowTagModal] = useState(false);
  const [tagValue, setTagValue] = useState("");
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const prevOpenRef = useRef(open);
  /** Tracks the message ID currently being streamed so we can normalise its markdown */
  const streamingMessageIdRef = useRef<string | null>(null);

  // Disable input when action requires UI interaction (buttons/options)
  const actionRequiresUiInput = pendingAction?.status === "pending_confirmation" ||
                                 pendingAction?.status === "needs_input" ||
                                 pendingAction?.status === "executing";
  const inputDisabled = loading || actionRequiresUiInput;
  const canSend = input.trim().length > 0 && !inputDisabled;
  const placeholder = useMemo(() => {
    if (loading) return "ShipBrain AI is processing...";
    if (pendingAction?.status === "executing") return "Action executing... Please wait.";
    if (pendingAction?.status === "pending_confirmation") return "Use the buttons above to confirm or cancel the action.";
    if (pendingAction?.status === "needs_input") return "Select an option above to continue.";
    return "Ask about PRs, deployments, or request an action...";
  }, [loading, pendingAction?.status]);

  // Auto-collapse suggestions when there are user messages
  const hasUserMessages = messages.some((m) => m.role === "user");
  useEffect(() => {
    if (hasUserMessages && messages.length > 3) {
      setSuggestionsExpanded(false);
    }
  }, [hasUserMessages, messages.length]);

  const loadThreads = useCallback(async () => {
    setLoadingThreads(true);
    try {
      const response = await fetch("/api/chat/threads?channel=web&limit=5", { cache: "no-store" });
      if (response.ok) {
        const data = await response.json();
        setThreads(Array.isArray(data) ? data : []);
      }
    } catch {
      // Ignore errors
    } finally {
      setLoadingThreads(false);
    }
  }, []);

  const saveCurrentThread = useCallback(async () => {
    const userMessages = messages.filter((m) => m.role === "user");
    if (userMessages.length === 0) return;

    try {
      const firstUserMessage = userMessages[0]?.content ?? "New conversation";
      const title = firstUserMessage.slice(0, 50) + (firstUserMessage.length > 50 ? "..." : "");

      await fetch("/api/chat/threads", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: threadId ? "save" : "create",
          threadId,
          title: !threadId ? title : undefined
        })
      });
    } catch {
      // Ignore errors
    }
  }, [threadId, messages]);

  const startNewThread = useCallback(async () => {
    await saveCurrentThread();
    setThreadId(null);
    setMessages([welcomeMessage]);
    setShowHistory(false);
    setSuggestionsExpanded(true);
    setPendingAction(null);
    void loadThreads();
  }, [saveCurrentThread, loadThreads]);

  const loadThread = useCallback(async (thread: ChatThread) => {
    await saveCurrentThread();
    setHydrating(true);
    try {
      const response = await fetch(`/api/chat?threadId=${thread.id}`, { cache: "no-store" });
      if (response.ok) {
        const data = await response.json();
        setThreadId(data.threadId ?? thread.id);
        if (Array.isArray(data.messages) && data.messages.length) {
          const maskedMessages = data.messages.map((msg: ChatMessage) => ({
            ...msg,
            content: maskSensitiveInfo(msg.content)
          }));
          setMessages(maskedMessages);
        } else {
          setMessages([welcomeMessage]);
        }
      }
    } catch {
      // Ignore
    } finally {
      setHydrating(false);
      setShowHistory(false);
      setPendingAction(null);
    }
  }, [saveCurrentThread]);

  const deleteThreadHandler = useCallback(async (threadIdToDelete: string, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await fetch("/api/chat/threads", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "delete", threadId: threadIdToDelete })
      });
      setThreads((prev) => prev.filter((t) => t.id !== threadIdToDelete));
      if (threadId === threadIdToDelete) {
        setThreadId(null);
        setMessages([welcomeMessage]);
        setPendingAction(null);
      }
    } catch {
      // Ignore
    }
  }, [threadId]);

  // Save thread when drawer closes
  useEffect(() => {
    if (prevOpenRef.current && !open) {
      void saveCurrentThread();
      void loadThreads();
    }
    prevOpenRef.current = open;
  }, [open, saveCurrentThread, loadThreads]);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      fetch("/api/chat", { cache: "no-store" }).then((r) => r.json()).catch(() => ({})),
      fetch("/api/chat/threads?channel=web&limit=5", { cache: "no-store" }).then((r) => r.json()).catch(() => []),
      fetch("/api/github/active-repo", { cache: "no-store" }).then((r) => r.json()).catch(() => ({}))
    ])
      .then(([chatData, threadsData, repoData]) => {
        if (cancelled) return;
        setThreadId(chatData.threadId ?? null);
        if (Array.isArray(chatData.messages) && chatData.messages.length) {
          const maskedMessages = chatData.messages.map((msg: ChatMessage) => ({
            ...msg,
            content: maskSensitiveInfo(msg.content)
          }));
          setMessages(maskedMessages);
        }
        if (Array.isArray(threadsData)) {
          setThreads(threadsData);
        }
        if (repoData.activeRepoFullName) {
          setActiveRepo(repoData.activeRepoFullName);
        }
      })
      .finally(() => {
        if (!cancelled) setHydrating(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, loading, open]);

  useEffect(() => {
    if (!open) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, open]);

  const sendMessage = useCallback(async (nextInput?: string, options?: { quickPromptId?: string }) => {
    const text = (nextInput ?? input).trim();
    if (!text || loading) return;

    const userMessage: ChatMessage = { id: `u-${Date.now()}`, role: "user", content: text };
    const assistantId = `a-${Date.now()}`;
    setMessages((items) => [...items, userMessage, { id: assistantId, role: "assistant", content: "" }]);
    setInput("");
    setLoading(true);
    streamingMessageIdRef.current = assistantId;

    try {
      const response = await fetch("/api/chat/stream", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          message: text,
          threadId,
          quickPromptId: options?.quickPromptId ?? null,
          pendingAction: pendingAction?.status === "pending_confirmation" || pendingAction?.status === "needs_input" ? pendingAction : null
        })
      });
      if (!response.ok || !response.body) throw new Error("ShipBrain AI could not start streaming right now.");

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split("\n\n");
        buffer = events.pop() ?? "";

        for (const rawEvent of events) {
          const lines = rawEvent.split("\n");
          const type = lines.find((line) => line.startsWith("event: "))?.slice(7) ?? "message";
          const dataLine = lines.find((line) => line.startsWith("data: "));
          const data = dataLine ? JSON.parse(dataLine.slice(6)) : {};

          if (type === "meta") {
            setThreadId(data.threadId ?? threadId);
          } else if (type === "context") {
            // Handle action state from context
            if (data.action) {
              setPendingAction(data.action);
            }
            if (data.responseSource) {
              setMessages((items) => items.map((item) =>
                item.id === assistantId ? { ...item, responseSource: data.responseSource } : item
              ));
            }
          } else if (type === "delta") {
            const maskedDelta = maskSensitiveInfo(data.delta ?? "");
            setMessages((items) => items.map((item) =>
              item.id === assistantId ? { ...item, content: item.content + maskedDelta } : item
            ));
          } else if (type === "done") {
            setThreadId(data.threadId ?? threadId);
            if (data.assistantMessage?.id) {
              const maskedContent = maskSensitiveInfo(data.assistantMessage.content ?? "");
              setMessages((items) => items.map((item) =>
                item.id === assistantId
                  ? {
                      id: data.assistantMessage.id,
                      role: "assistant",
                      content: maskedContent || item.content,
                      responseSource: data.assistantMessage.responseSource ?? data.responseSource ?? item.responseSource ?? null
                    }
                  : item
              ));
            }
            // Update action state from done event
            if (data.action) {
              setPendingAction(data.action);
            } else if (data.action === null) {
              setPendingAction(null);
            }
          } else if (type === "error") {
            throw new Error(data.error ?? "ShipBrain AI stream failed.");
          }
        }
      }
    } catch (error) {
      setMessages((items) => items.map((item) =>
        item.id === assistantId
          ? { ...item, content: error instanceof Error ? error.message : "ShipBrain AI could not answer right now." }
          : item
      ));
    } finally {
      streamingMessageIdRef.current = null;
      setLoading(false);
    }
  }, [input, loading, threadId, pendingAction]);

  useEffect(() => {
    const handleOpenChatPrompt = (e: Event) => {
      const customEvent = e as CustomEvent<{ prompt?: string }>;
      if (customEvent.detail?.prompt) {
        void sendMessage(customEvent.detail.prompt);
      }
    };
    window.addEventListener("shipbrain-open-chat", handleOpenChatPrompt);
    return () => window.removeEventListener("shipbrain-open-chat", handleOpenChatPrompt);
  }, [sendMessage]);

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void sendMessage();
  }

  function handleConfirm() {
    const isProdRelease = pendingAction?.type === "deploy_production" || 
                         (pendingAction?.type === "approve_hotfix" && pendingAction?.params?.baseBranch === "main");
    
    if (isProdRelease) {
      const suggestedTag = pendingAction?.params?.releaseTag || "";
      setTagValue(suggestedTag);
      setShowTagModal(true);
    } else {
      void sendMessage("confirm");
    }
  }

  function handleModalConfirm(customTag: string) {
    setShowTagModal(false);
    if (customTag.trim()) {
      void sendMessage(`confirm tag ${customTag.trim()}`);
    } else {
      void sendMessage("confirm");
    }
  }

  function handleCancel() {
    void sendMessage("cancel");
  }

  function handleSelectActionOption(optionValue: string) {
    void sendMessage(optionValue);
  }

  async function handleSelectRecipe(recipeId: string) {
    // Find the recipe from the pending action params
    const recipes = pendingAction?.params?.recipes as RecipeOption[] | undefined;
    const selectedRecipe = recipes?.find((r) => r.id === recipeId);

    if (!selectedRecipe) {
      void sendMessage(`Use recipe ${recipeId} for spec-to-pr`);
      return;
    }

    // Capture repoFullName before clearing pending action
    const repoFullName = activeRepo || pendingAction?.params?.repoFullName;

    // Clear pending action and show executing state
    setPendingAction(null);
    setLoading(true);

    const userMsgId = `u-${Date.now()}`;
    const assistantMsgId = `a-${Date.now()}`;

    // Add user selection message and placeholder for assistant response
    setMessages((items) => [
      ...items,
      {
        id: userMsgId,
        role: "user",
        content: `Create Draft PR using "${selectedRecipe.label}" recipe`
      },
      {
        id: assistantMsgId,
        role: "assistant",
        content: ""
      }
    ]);

    try {
      // Execute the spec-to-pr action directly
      const response = await fetch("/api/ai/spec-to-pr", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          recipeId,
          createPr: true,
          repoFullName
        })
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || data.detail || "Failed to create PR");
      }

      // Format success message
      const prUrl = data.pr?.html_url || data.pr?.url || "#";
      const prNumber = data.pr?.number || "?";
      const branch = data.pr?.head?.ref || data.suggestedBranch || "feature/...";
      const filesCount = data.scaffold?.length || 0;

      const successMessage = `**Draft PR Created Successfully!**

- PR: [#${prNumber}](${prUrl})
- Branch: \`${branch}\`
- Files: ${filesCount} files generated

The PR is ready for review on GitHub.`;

      setMessages((items) =>
        items.map((item) =>
          item.id === assistantMsgId ? { ...item, content: successMessage } : item
        )
      );

      setPendingAction({
        type: "spec_to_pr",
        status: "completed",
        params: { recipeId },
        result: data
      });
    } catch (error) {
      const errorMessage = `**Failed to create Draft PR**

${error instanceof Error ? error.message : "An unexpected error occurred."}

Please try again or check the console for more details.`;

      setMessages((items) =>
        items.map((item) =>
          item.id === assistantMsgId ? { ...item, content: errorMessage } : item
        )
      );

      setPendingAction({
        type: "spec_to_pr",
        status: "failed",
        params: { recipeId },
        error: error instanceof Error ? error.message : "Unknown error"
      });
    } finally {
      setLoading(false);
    }
  }

  function toggleHistory() {
    setShowHistory((current) => {
      const next = !current;
      if (next) void loadThreads();
      return next;
    });
  }

  function formatTimeAgo(dateStr: string) {
    const date = new Date(dateStr);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    if (diffMins < 1) return "just now";
    if (diffMins < 60) return `${diffMins}m ago`;
    const diffHours = Math.floor(diffMins / 60);
    if (diffHours < 24) return `${diffHours}h ago`;
    const diffDays = Math.floor(diffHours / 24);
    if (diffDays < 7) return `${diffDays}d ago`;
    return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  }

  return (
    <>
      <button
        className={`chat-drawer-backdrop ${open ? "show" : ""}`}
        type="button"
        aria-label="Close ShipBrain AI chat"
        onClick={onClose}
      />
      <aside className={`chat-drawer ${open ? "open" : ""}`} aria-label="ShipBrain AI chat" aria-hidden={!open}>
        <div className="chat-drawer-head">
          <div>
            <strong>ShipBrain AI</strong>
            <span>{hydrating ? "Loading context" : pendingAction ? "Action pending" : "Ready"}</span>
          </div>
          <div className="chat-drawer-head-actions">
            <button
              className="icon-button"
              type="button"
              aria-label="Chat history"
              title="Chat history"
              aria-expanded={showHistory}
              onClick={toggleHistory}
            >
              <Clock size={17} />
            </button>
            <button
              className="icon-button"
              type="button"
              aria-label="New chat"
              title="New chat"
              onClick={() => void startNewThread()}
            >
              <Plus size={17} />
            </button>
            <button className="icon-button" type="button" aria-label="Close chat" onClick={onClose}>
              <X size={17} />
            </button>
          </div>
        </div>

        {showHistory && (
          <div className="chat-history-panel">
            <div className="chat-history-header">
              <span>Recent conversations</span>
              <small>{threads.length} of 5 max</small>
            </div>
            {loadingThreads ? (
              <div className="chat-history-loading">
                <Loader2 size={16} className="spin" />
                Loading...
              </div>
            ) : threads.length === 0 ? (
              <div className="chat-history-empty">
                <MessageSquare size={20} />
                <span>No conversation history yet</span>
              </div>
            ) : (
              <div className="chat-history-list">
                {threads.map((thread) => (
                  <button
                    key={thread.id}
                    type="button"
                    className={`chat-history-item ${thread.id === threadId ? "active" : ""}`}
                    onClick={() => void loadThread(thread)}
                  >
                    <div className="chat-history-item-content">
                      <strong>{thread.title}</strong>
                      {thread.lastMessage && (
                        <span className="chat-history-preview">{maskSensitiveInfo(thread.lastMessage)}</span>
                      )}
                      <small>
                        {thread.messageCount} message{thread.messageCount !== 1 ? "s" : ""} · {formatTimeAgo(thread.updated_at)}
                      </small>
                    </div>
                    <button
                      type="button"
                      className="chat-history-delete"
                      aria-label="Delete conversation"
                      onClick={(e) => void deleteThreadHandler(thread.id, e)}
                    >
                      <Trash2 size={14} />
                    </button>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        <section className="chat-workspace chat-drawer-workspace">
          <div className="chat-messages" aria-live="polite" ref={scrollRef}>
            {messages.map((message) => {
              const isTyping = message.role === "assistant" && loading && !message.content;
              return (
              <article className={`chat-message ${message.role}${isTyping ? " typing" : ""}`} key={message.id}>
                <div className="chat-avatar" aria-hidden="true">
                  {message.role === "assistant" ? <Bot size={16} /> : <UserRound size={16} />}
                </div>
                <div className="chat-bubble">
                  {!isTyping && (
                    <div className="chat-role">
                      <span>{message.role === "assistant" ? "ShipBrain AI" : "You"}</span>
                      {message.role === "assistant" && message.responseSource === "foundry_iq" && (
                        <span className="chat-source-badge" title="Grounded by the deployed Foundry IQ knowledge source">
                          <BookOpen size={11} />
                          Foundry IQ
                        </span>
                      )}
                    </div>
                  )}
                  {isTyping ? (
                    <TypingIndicator />
                  ) : message.role === "assistant" ? (
                    <div className="chat-content">
                      <ReactMarkdown
                        components={{
                          p: ({ children }) => <p>{children}</p>,
                          strong: ({ children }) => <strong>{children}</strong>,
                          em: ({ children }) => <em>{children}</em>,
                          code: ({ children, className }) => {
                            const isInline = !className;
                            const text = String(children).replace(/\n$/, "");

                            // Check if this inline code is a spec ID (UUID)
                            if (isInline && isSpecId(text)) {
                              return (
                                <SpecCitation specId={text}>
                                  <code className="inline-code">{children}</code>
                                </SpecCitation>
                              );
                            }

                            return isInline ? (
                              <code className="inline-code">{children}</code>
                            ) : (
                              <code className="block-code">{children}</code>
                            );
                          },
                          pre: ({ children }) => <pre className="code-block">{children}</pre>,
                          ul: ({ children }) => <ul className="chat-list">{children}</ul>,
                          ol: ({ children }) => <ol className="chat-list ordered">{children}</ol>,
                          li: ({ children }) => <li>{children}</li>,
                          a: ({ href, children }) => (
                            <a href={href} target="_blank" rel="noopener noreferrer" className="chat-link">
                              {children}
                            </a>
                          ),
                          h1: ({ children }) => <strong className="chat-heading">{children}</strong>,
                          h2: ({ children }) => <strong className="chat-heading">{children}</strong>,
                          h3: ({ children }) => <strong className="chat-heading">{children}</strong>,
                        }}
                      >
                        {/* Normalise single \n → \n\n during streaming so ReactMarkdown
                            creates visible paragraph breaks instead of collapsing them */}
                        {streamingMessageIdRef.current === message.id
                          ? normalizeMarkdown(message.content)
                          : message.content}
                      </ReactMarkdown>
                    </div>
                  ) : (
                    <p>{message.content}</p>
                  )}
                </div>
              </article>
            );
            })}
          </div>

          {/* Guided Action Options — selectable chips for write tool params */}
          {pendingAction?.status === "pending_confirmation" &&
           Array.isArray(pendingAction.options) &&
           pendingAction.options.length > 0 && (
            <div className="chat-action-options" aria-label={`Options for ${getActionLabel(pendingAction.type)}`}>
              <div className="chat-action-options-head">
                <Layers size={13} />
                <span>Select which {pendingAction.type.includes("incident") ? "incident" : pendingAction.type.includes("release") || pendingAction.type === "approve_release" ? "release" : "PR"} to {getActionLabel(pendingAction.type).toLowerCase()}</span>
              </div>
              <div className="chat-action-options-list">
                {pendingAction.options.map((opt, i) => (
                  <button
                    key={i}
                    type="button"
                    className={`chat-action-option-chip ${getRiskClass(pendingAction.type)}`}
                    onClick={() => handleSelectActionOption(opt.value)}
                    disabled={loading}
                  >
                    <span className="chat-option-chip-body">
                      <strong>{opt.label}</strong>
                      {opt.sublabel && <small>{opt.sublabel}</small>}
                    </span>
                    {opt.badge && <span className="chat-option-chip-badge">{opt.badge}</span>}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Action Confirmation Bar */}
          {pendingAction && pendingAction.status === "pending_confirmation" && (
            <div className={`chat-action-confirm ${getRiskClass(pendingAction.type)}`}>
              <div className="chat-action-info">
                <Zap size={16} />
                <div>
                  <strong>{getActionLabel(pendingAction.type)}</strong>
                  <span>
                    {pendingAction.type.includes("production") || pendingAction.type === "rollback"
                      ? "This will affect production"
                      : "Ready to execute"}
                  </span>
                </div>
              </div>
              <div className="chat-action-buttons">
                <button
                  type="button"
                  className="chat-action-cancel"
                  onClick={handleCancel}
                  disabled={loading}
                >
                  <X size={14} />
                  Cancel
                </button>
                <button
                  type="button"
                  className="chat-action-confirm-btn"
                  onClick={handleConfirm}
                  disabled={loading}
                >
                  {loading ? <Loader2 size={14} className="spin" /> : <Check size={14} />}
                  Confirm
                </button>
              </div>
            </div>
          )}

          {/* Action Status Indicator */}
          {pendingAction && pendingAction.status === "completed" && (
            <div className="chat-action-status completed">
              <Check size={14} />
              <span>Action completed successfully</span>
            </div>
          )}

          {pendingAction && pendingAction.status === "failed" && (
            <div className="chat-action-status failed">
              <AlertTriangle size={14} />
              <span>Action failed: {pendingAction.error}</span>
            </div>
          )}

          {pendingAction?.type === "spec_to_pr" && pendingAction.status === "needs_input" && Array.isArray(pendingAction.params?.recipes) && (
            <div className="chat-option-panel" aria-label="Spec-to-PR recipe options">
              <div className="chat-option-head">
                <Sparkles size={14} />
                <span>Choose a PR recipe</span>
              </div>
              <div className="chat-option-list">
                {(pendingAction.params.recipes as RecipeOption[]).map((recipe) => (
                  <button
                    className="chat-option-card"
                    type="button"
                    key={recipe.id}
                    onClick={() => handleSelectRecipe(recipe.id)}
                    disabled={loading}
                  >
                    <span className="chat-option-icon">{recipe.prefix.slice(0, 1).toUpperCase()}</span>
                    <span className="chat-option-copy">
                      <strong>{recipe.label}{recipe.isSample ? " · sample" : ""}</strong>
                      <small>{recipe.heading ?? recipe.id} · {recipeBranchLabel(recipe)}</small>
                    </span>
                    <span className="chat-option-cta">Use</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Collapsible Suggestions Accordion */}
          <div className={`chat-suggestions-accordion ${suggestionsExpanded ? "expanded" : "collapsed"}`}>
            <button
              type="button"
              className="chat-suggestions-toggle"
              onClick={() => setSuggestionsExpanded(!suggestionsExpanded)}
              aria-expanded={suggestionsExpanded}
            >
              <Sparkles size={14} />
              <span>Quick prompts</span>
              {suggestionsExpanded ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
            </button>
            {suggestionsExpanded && (
              <div className="chat-suggestions">
                {quickPrompts.map(({ id, label, prompt, Icon, category }) => (
                  <button
                    type="button"
                    key={prompt}
                    className={`chat-suggestion-btn cat-${category}`}
                    onClick={() => void sendMessage(prompt, { quickPromptId: id })}
                    disabled={loading}
                    title={prompt}
                  >
                    <span className="chat-suggestion-icon">
                      <Icon size={13} />
                    </span>
                    <span className="chat-suggestion-label">{label}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          <form className="chat-composer" onSubmit={onSubmit}>
            <textarea
              value={input}
              onChange={(event) => setInput(event.target.value)}
              placeholder={placeholder}
              rows={2}
              disabled={inputDisabled}
              aria-disabled={inputDisabled}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey && !inputDisabled) {
                  event.preventDefault();
                  void sendMessage();
                }
              }}
            />
            <button type="submit" disabled={!canSend} aria-label="Send message">
              {loading ? <Loader2 size={16} className="spin" /> : <Send size={16} />}
            </button>
          </form>
          <InputModal
            open={showTagModal}
            title="Confirm Production Release Tag"
            label="Production Release Tag Name"
            placeholder="e.g. release-v2026.06.01"
            defaultValue={tagValue}
            confirmLabel="Confirm Deployment"
            cancelLabel="Cancel"
            required={true}
            onClose={() => setShowTagModal(false)}
            onConfirm={handleModalConfirm}
          />
        </section>
      </aside>
    </>
  );
}
