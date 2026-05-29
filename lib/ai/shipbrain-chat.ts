import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { getModel } from "@/lib/ai/model";
import { getShipBrainAgentContext } from "@/lib/agent/context";
import { listChatMessages, type StoredChatMessage } from "@/lib/ai/chat-store";
import {
  detectIntent,
  generateConfirmation,
  executeAction,
  formatActionResult,
  ACTION_DEFINITIONS,
  type ActionIntent,
  type ChatAction
} from "@/lib/ai/chat-actions";

type SupabaseLike = {
  from: (table: string) => any;
};

const systemPrompt = `You are ShipBrain AI, a senior production engineering assistant that can both inform AND execute operations.

## Repository Onboarding (CRITICAL - Check First!)
Before any operation, check if the user has connected repos in the context.
- If NO repos are connected (repos array is empty), guide the user to connect a repository first:
  "To get started with ShipBrain, you need to connect a GitHub repository first. Go to **Settings > Repositories** to connect your repo."
- If repos are connected but NONE have setup_status = "complete", guide them to complete setup:
  "I see you have connected [repo name], but the setup isn't complete yet. Please complete the repository setup in Settings to enable all ShipBrain features."
- Only proceed with operations when at least one repo is fully set up.

## Your Capabilities
You can execute these operations when the user requests them:
- **Spec-to-PR**: Create Draft PRs from specifications
- **Deploy Preview**: Deploy to preview/develop environment
- **Deploy Production**: Create release tags and deploy to production
- **Approve Release**: Approve pending deployments
- **Rollback**: Rollback to previous releases
- **Create Hotfix**: Create hotfix PRs for incidents
- **Approve Hotfix**: Merge and deploy hotfixes
- **Analyze Incident**: Run AI analysis on incidents

## How to Handle Operations

### When user requests an action:
1. If you detect they want to perform an operation, acknowledge it clearly
2. If parameters are missing, ask specific clarifying questions
3. Once you have all parameters, describe what will happen
4. Always require explicit confirmation for production-impacting actions
5. Use markdown formatting for clear responses

### Action Metadata
- Never show internal action metadata such as ACTION_DETECTED, PARAMS, or MISSING to the user
- Ask the user a clear question when required details or confirmation are needed
- Keep operation responses conversational and user-facing

### Confirmation Flow:
- For read-only operations (view_*): Execute immediately
- For write operations: Ask for "confirm" or "cancel"
- For high-risk operations (production, rollback): Double-check with warnings

## Context Usage
- Use the provided ShipBrain context as your source of truth
- Never invent data - if context is missing, say so
- Reference specific IDs, tags, and statuses from context
- Use specPrRecipes from context when the user asks for Spec-to-PR sample tickets, templates, or Quick PR Recipes
- Mask any sensitive information (API keys, tokens, secrets)

## Response Style
- Be concise but complete
- Use bullet points for lists
- Use code blocks for IDs and commands
- Include relevant links when available
- Explain risks for production operations
- End action confirmations and missing-parameter responses with a direct question

## Example Interactions:

User: "Deploy my feature to production"
You: I can deploy to production. Let me check the context...
[If spec found] I found spec \`abc123\` ready for production. This will:
- Create release tag \`release-v2024.05.29-1430\`
- Deploy to production environment
- Notify configured channels

⚠️ This is a production deployment. Type **confirm** to proceed or **cancel** to abort.

User: "Rollback to the previous release"
You: I can initiate a rollback. Available releases:
1. \`release-v2024.05.28-1200\` - Feature X (current)
2. \`release-v2024.05.27-0900\` - Feature Y

Which release would you like to rollback to?`;

function actionFromIntent(intent: ActionIntent, context: any): ChatAction | null {
  if (!intent.detected || !intent.action) return null;
  if (intent.missingParams.length > 0) {
    return {
      type: intent.action,
      status: "needs_input",
      params: intent.params,
      missingParams: intent.missingParams
    };
  }

  const def = ACTION_DEFINITIONS[intent.action];
  if (!def.confirmRequired) return null;
  return {
    type: intent.action,
    status: "pending_confirmation",
    params: intent.params,
    confirmationMessage: generateConfirmation(intent.action, intent.params, context)
  };
}

function actionPromptReply(intent: ActionIntent, context: any): string | null {
  if (!intent.detected || !intent.action) return null;
  if (intent.missingParams.length > 0) {
    return intent.clarifyingQuestion ?? "Could you share the missing details so I can continue?";
  }

  const def = ACTION_DEFINITIONS[intent.action];
  if (def.confirmRequired) {
    return generateConfirmation(intent.action, intent.params, context);
  }

  return null;
}

async function* textStream(content: string) {
  yield { content };
}

// Check if user needs to complete repo onboarding first
function checkRepoOnboarding(context: any): string | null {
  const repos = Array.isArray(context.repos) ? context.repos : [];
  const activeRepo = context.activeRepo;

  // If there's an active repo selected, allow operations
  if (activeRepo) {
    return null;
  }

  // If no repos at all, guide to connect
  if (repos.length === 0) {
    return `**Welcome to ShipBrain!**

To get started, you need to connect a GitHub repository first.

**Next steps:**
1. Go to **Settings** in the sidebar
2. Click **Repositories**
3. Connect your GitHub repo

Once connected, I can help you with:
- Creating PRs from specs
- Managing deployments
- Handling releases and rollbacks
- Incident management

Would you like me to guide you through the setup process?`;
  }

  // Repos exist but none selected as active - just proceed, the system will use the first one
  return null;
}

function specRecipeInteraction(message: string, context: any): { reply: string; action: ChatAction | null } | null {
  const lower = message.toLowerCase();
  const recipes = Array.isArray(context.specPrRecipes) ? context.specPrRecipes : [];
  const asksForRecipes =
    /quick\s+pr\s+recipes?/.test(lower) ||
    /spec(?:-|\s*)to(?:-|\s*)pr\s+(?:recipes?|templates?|samples?)/.test(lower) ||
    /(?:show|list|what|which|give|load).*(?:sample\s+ticket|recipes?|templates?)/.test(lower);
  const mentionedRecipe = recipes.find((recipe: any) => {
    const haystack = [recipe.id, recipe.label, recipe.prefix, recipe.heading]
      .filter(Boolean)
      .map((value) => String(value).toLowerCase());
    return /(?:recipe|template|sample\s+ticket)/.test(lower) && haystack.some((value) => lower.includes(value));
  });

  if (!asksForRecipes && !mentionedRecipe) return null;
  if (!recipes.length) {
    return {
      reply: "I do not see any Spec-to-PR recipes loaded yet. Would you like to paste a ticket manually instead?",
      action: null
    };
  }

  const toOption = (recipe: any) => ({
    id: recipe.id,
    label: recipe.label,
    prefix: recipe.prefix,
    heading: recipe.heading,
    baseBranch: recipe.baseBranch,
    sourceBranch: recipe.sourceBranch,
    isSample: recipe.isSample
  });

  if (mentionedRecipe) {
    const branch = mentionedRecipe.sourceBranch
      ? `${mentionedRecipe.sourceBranch} -> ${mentionedRecipe.baseBranch}`
      : mentionedRecipe.baseBranch;
    return {
      reply: `I found the ${mentionedRecipe.label} Spec-to-PR recipe for ${branch}. Would you like to use it?`,
      action: {
        type: "spec_to_pr",
        status: "needs_input",
        params: {
          mode: "recipe_selection",
          recipes: [toOption(mentionedRecipe)]
        },
        missingParams: ["recipeId"]
      }
    };
  }

  const sample = recipes.find((recipe: any) => recipe.isSample);
  return {
    reply: sample
      ? `I found ${recipes.length} Spec-to-PR recipes. Would you like to start with the sample ticket or choose another recipe?`
      : `I found ${recipes.length} Spec-to-PR recipes. Which one would you like to use?`,
    action: {
      type: "spec_to_pr",
      status: "needs_input",
      params: {
        mode: "recipe_selection",
        recipes: recipes.map(toOption)
      },
      missingParams: ["recipeId"]
    }
  };
}

function historyText(messages: StoredChatMessage[]) {
  if (!messages.length) return "No previous messages in this thread.";
  return messages
    .slice(-12)
    .map((message) => `${message.role === "assistant" ? "Assistant" : "User"}: ${message.content}`)
    .join("\n\n");
}

// Check if message is a confirmation
export function isConfirmation(message: string): boolean {
  const lower = message.toLowerCase().trim();
  return ["confirm", "yes", "proceed", "do it", "go ahead", "ok", "okay"].includes(lower);
}

// Check if message is a cancellation
export function isCancellation(message: string): boolean {
  const lower = message.toLowerCase().trim();
  return ["cancel", "no", "abort", "stop", "nevermind", "never mind"].includes(lower);
}

export async function answerShipBrainQuestion(input: {
  supabase: SupabaseLike;
  userId: string;
  userEmail?: string | null;
  repoFullName?: string | null;
  threadId?: string | null;
  message: string;
  limit?: number;
  pendingAction?: ChatAction | null;
}) {
  const context = await getShipBrainAgentContext({
    supabase: input.supabase,
    userId: input.userId,
    repoFullName: input.repoFullName ?? null,
    limit: input.limit ?? 12
  });

  const history = input.threadId
    ? await listChatMessages({
        supabase: input.supabase,
        userId: input.userId,
        threadId: input.threadId,
        limit: 12
      })
    : [];

  // Check for action intent
  const intent = detectIntent(input.message, context);

  const recipeInteraction = specRecipeInteraction(input.message, context);
  if (recipeInteraction) {
    return {
      reply: recipeInteraction.reply,
      activeRepo: context.activeRepo,
      context,
      historyCount: history.length,
      action: recipeInteraction.action,
      intent
    };
  }

  const deterministicActionReply = actionPromptReply(intent, context);
  if (deterministicActionReply) {
    return {
      reply: deterministicActionReply,
      activeRepo: context.activeRepo,
      context,
      historyCount: history.length,
      action: actionFromIntent(intent, context),
      intent
    };
  }

  // Handle pending action confirmation/cancellation
  if (input.pendingAction && input.pendingAction.status === "pending_confirmation") {
    if (isConfirmation(input.message)) {
      // Execute the pending action
      const result = await executeAction(
        input.pendingAction.type,
        input.pendingAction.params,
        input.supabase as any,
        input.userId,
        input.repoFullName ?? null
      );

      if (result.success) {
        return {
          reply: formatActionResult(input.pendingAction.type, result.result),
          activeRepo: context.activeRepo,
          context,
          historyCount: history.length,
          action: {
            ...input.pendingAction,
            status: "completed" as const,
            result: result.result
          }
        };
      } else {
        return {
          reply: `❌ **Action Failed**\n\n${result.error}`,
          activeRepo: context.activeRepo,
          context,
          historyCount: history.length,
          action: {
            ...input.pendingAction,
            status: "failed" as const,
            error: result.error
          }
        };
      }
    } else if (isCancellation(input.message)) {
      return {
        reply: "Action cancelled. What else can I help you with?",
        activeRepo: context.activeRepo,
        context,
        historyCount: history.length,
        action: null
      };
    }
  }

  // Build the prompt with action detection info
  const model = getModel({ temperature: 0.2 });

  let actionContext = "";
  if (intent.detected && intent.action) {
    const def = ACTION_DEFINITIONS[intent.action];
    actionContext = `
DETECTED ACTION INTENT: ${intent.action}
Action: ${def.label} - ${def.description}
Extracted Params: ${JSON.stringify(intent.params)}
Missing Params: ${intent.missingParams.length > 0 ? intent.missingParams.join(", ") : "none"}
Risk Level: ${def.riskLevel}
Requires Confirmation: ${def.confirmRequired}
`;
  }

  const response = await model.invoke([
    new SystemMessage(systemPrompt),
    new HumanMessage(
      [
        `Current user: ${input.userEmail ?? input.userId}`,
        `Active repo: ${context.activeRepo ?? "none selected"}`,
        actionContext,
        "Fresh ShipBrain context JSON:",
        JSON.stringify(context, null, 2),
        "",
        "Recent chat thread history:",
        historyText(history),
        "",
        "User message:",
        input.message
      ].join("\n")
    )
  ]);

  const reply = typeof response.content === "string" ? response.content : JSON.stringify(response.content);

  // If action detected with all params, create pending action
  let action: ChatAction | null = null;
  if (intent.detected && intent.action && intent.missingParams.length === 0) {
    const def = ACTION_DEFINITIONS[intent.action];
    if (def.confirmRequired) {
      action = {
        type: intent.action,
        status: "pending_confirmation",
        params: intent.params,
        confirmationMessage: generateConfirmation(intent.action, intent.params, context)
      };
    } else {
      // Execute immediately for read-only operations
      const result = await executeAction(
        intent.action,
        intent.params,
        input.supabase as any,
        input.userId,
        input.repoFullName ?? null
      );
      if (result.success) {
        action = {
          type: intent.action,
          status: "completed",
          params: intent.params,
          result: result.result
        };
      }
    }
  } else if (intent.detected && intent.action && intent.missingParams.length > 0) {
    action = {
      type: intent.action,
      status: "needs_input",
      params: intent.params,
      missingParams: intent.missingParams
    };
  }

  return {
    reply,
    activeRepo: context.activeRepo,
    context,
    historyCount: history.length,
    action,
    intent
  };
}

export async function buildShipBrainChatPrompt(input: {
  supabase: SupabaseLike;
  userId: string;
  userEmail?: string | null;
  repoFullName?: string | null;
  threadId?: string | null;
  message: string;
  limit?: number;
  pendingAction?: ChatAction | null;
}) {
  const context = await getShipBrainAgentContext({
    supabase: input.supabase,
    userId: input.userId,
    repoFullName: input.repoFullName ?? null,
    limit: input.limit ?? 12
  });

  const history = input.threadId
    ? await listChatMessages({
        supabase: input.supabase,
        userId: input.userId,
        threadId: input.threadId,
        limit: 12
      })
    : [];

  // Check for action intent
  const intent = detectIntent(input.message, context);

  let actionContext = "";
  if (intent.detected && intent.action) {
    const def = ACTION_DEFINITIONS[intent.action];
    actionContext = `
DETECTED ACTION INTENT: ${intent.action}
Action: ${def.label} - ${def.description}
Extracted Params: ${JSON.stringify(intent.params)}
Missing Params: ${intent.missingParams.length > 0 ? intent.missingParams.join(", ") : "none"}
Risk Level: ${def.riskLevel}
Requires Confirmation: ${def.confirmRequired}
`;
  }

  return {
    context,
    history,
    intent,
    messages: [
      new SystemMessage(systemPrompt),
      new HumanMessage(
        [
          `Current user: ${input.userEmail ?? input.userId}`,
          `Active repo: ${context.activeRepo ?? "none selected"}`,
          actionContext,
          "Fresh ShipBrain context JSON:",
          JSON.stringify(context, null, 2),
          "",
          "Recent chat thread history:",
          historyText(history),
          "",
          "User message:",
          input.message
        ].join("\n")
      )
    ]
  };
}

export async function streamShipBrainQuestion(input: {
  supabase: SupabaseLike;
  userId: string;
  userEmail?: string | null;
  repoFullName?: string | null;
  threadId?: string | null;
  message: string;
  limit?: number;
  pendingAction?: ChatAction | null;
}) {
  const prompt = await buildShipBrainChatPrompt(input);

  // Check if user needs repo onboarding first (skip for general questions)
  const lowerMessage = input.message.toLowerCase();
  const isGeneralQuestion = /^(hi|hello|hey|help|what can you do|how do i)/i.test(lowerMessage);
  if (!isGeneralQuestion && !input.pendingAction) {
    const onboardingMessage = checkRepoOnboarding(prompt.context);
    if (onboardingMessage) {
      return {
        ...prompt,
        action: null,
        stream: textStream(onboardingMessage)
      };
    }
  }

  // Handle pending action confirmation/cancellation for streaming
  if (input.pendingAction && input.pendingAction.status === "pending_confirmation") {
    if (isConfirmation(input.message)) {
      const result = await executeAction(
        input.pendingAction.type,
        input.pendingAction.params,
        input.supabase as any,
        input.userId,
        input.repoFullName ?? null
      );

      const reply = result.success
        ? formatActionResult(input.pendingAction.type, result.result)
        : `❌ **Action Failed**\n\n${result.error}`;

      // Return as async generator for consistency
      return {
        ...prompt,
        action: result.success
          ? { ...input.pendingAction, status: "completed" as const, result: result.result }
          : { ...input.pendingAction, status: "failed" as const, error: result.error },
        stream: textStream(reply)
      };
    } else if (isCancellation(input.message)) {
      return {
        ...prompt,
        action: null,
        stream: textStream("Action cancelled. What else can I help you with?")
      };
    }
  }

  // Handle recipe selection/confirmation when user has a pending spec_to_pr needs_input action
  if (
    input.pendingAction &&
    input.pendingAction.type === "spec_to_pr" &&
    input.pendingAction.status === "needs_input"
  ) {
    const recipes = input.pendingAction.params?.recipes as Array<{ id: string; label: string; heading?: string }> | undefined;
    if (recipes && recipes.length > 0) {
      let selectedRecipe: { id: string; label: string } | undefined;

      // Case 1: Single recipe and user confirms
      if (recipes.length === 1 && isConfirmation(input.message)) {
        selectedRecipe = recipes[0];
      }

      // Case 2: User mentions a specific recipe by name/label/id
      if (!selectedRecipe) {
        const lower = input.message.toLowerCase();
        selectedRecipe = recipes.find((r) => {
          const searchTerms = [r.id, r.label, r.heading].filter(Boolean).map((s) => String(s).toLowerCase());
          return searchTerms.some((term) => lower.includes(term));
        });
      }

      // Case 3: User says "first one", "the sample", etc.
      if (!selectedRecipe) {
        const lower = input.message.toLowerCase();
        if (/first|sample|1st|one/.test(lower)) {
          selectedRecipe = recipes.find((r: any) => r.isSample) || recipes[0];
        }
      }

      if (selectedRecipe) {
        // Execute the spec_to_pr action with the selected recipe
        const result = await executeAction(
          "spec_to_pr",
          {
            ...input.pendingAction.params,
            recipeId: selectedRecipe.id,
            repoFullName: input.repoFullName
          },
          input.supabase as any,
          input.userId,
          input.repoFullName ?? null
        );

        const reply = result.success
          ? formatActionResult("spec_to_pr", result.result)
          : `❌ **Failed to create Draft PR**\n\n${result.error}`;

        return {
          ...prompt,
          action: result.success
            ? { ...input.pendingAction, status: "completed" as const, result: result.result }
            : { ...input.pendingAction, status: "failed" as const, error: result.error },
          stream: textStream(reply)
        };
      }
    }
  }

  const recipeInteraction = specRecipeInteraction(input.message, prompt.context);
  if (recipeInteraction) {
    return {
      ...prompt,
      action: recipeInteraction.action,
      stream: textStream(recipeInteraction.reply)
    };
  }

  const deterministicActionReply = actionPromptReply(prompt.intent, prompt.context);
  if (deterministicActionReply) {
    return {
      ...prompt,
      action: actionFromIntent(prompt.intent, prompt.context),
      stream: textStream(deterministicActionReply)
    };
  }

  const model = getModel({ temperature: 0.2, streaming: true });
  const stream = await model.stream(prompt.messages);

  // Determine action state
  let action: ChatAction | null = null;
  if (prompt.intent.detected && prompt.intent.action && prompt.intent.missingParams.length === 0) {
    const def = ACTION_DEFINITIONS[prompt.intent.action];
    if (def.confirmRequired) {
      action = {
        type: prompt.intent.action,
        status: "pending_confirmation",
        params: prompt.intent.params,
        confirmationMessage: generateConfirmation(prompt.intent.action, prompt.intent.params, prompt.context)
      };
    }
  } else if (prompt.intent.detected && prompt.intent.action && prompt.intent.missingParams.length > 0) {
    action = {
      type: prompt.intent.action,
      status: "needs_input",
      params: prompt.intent.params,
      missingParams: prompt.intent.missingParams
    };
  }

  return {
    ...prompt,
    action,
    stream
  };
}
