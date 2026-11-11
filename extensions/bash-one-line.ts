/**
 * bash-one-line — compact single-row bash calls and boxed user messages for Gentle Shell.
 *
 * What it does:
 * 1. Bash calls: one card with a shell prompt glyph and a short statement:
 *      $  bash  search bee                         done · 17ms  ctrl+o
 *    - Glyph: `$`, one cell, ASCII. Never the bee emoji (a font may not carry
 *      it, and an emoji drifts the left column) and never the `=` of read.
 *    - Statement: `# intent:` when declared, otherwise a deterministic summary
 *      of the command's first verb; an unmatched command keeps its first line.
 *    - Style: the live Cards style. Float paints the tone panel behind every
 *      row; neon closes a rounded frame, exactly like a Gentle card.
 *    - Expanded (Ctrl+O): delegates completely to the original renderer.
 * 2. Default-shell tools (background jobs, MCP, and future tools) use the live
 *    Neon/Float card style. Existing self-framed renderers stay untouched.
 *    Original call/result components, expansion, images, and renderer state remain native.
 * 3. User messages: follow the live Cards style, with a pink mustache and text.
 *    Neon has a transparent closed outline with the mustache in the top rule;
 *    float paints the input's panel background with the mustache inline on the
 *    first text row, accent rail and outer margins.
 *
 * To remove: delete this file and run /reload.
 *
 * INSTALL NOTE: the import at the bottom of the header block is a placeholder.
 * `install.sh` / `install.ps1` replace the placeholder specifier in the imports below
 * with the absolute path of gentle-pi's lib/shell-card.ts on the target machine.
 * Copying this file by hand without substituting it makes the extension fail to load.
 */
import {
	AssistantMessageComponent,
	CustomMessageComponent,
	ExtensionRunner,
	type ExtensionAPI,
	type ToolRenderContext,
	type ToolRenderers,
	ToolExecutionComponent,
	UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import {
	type Component,
	Text,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

import {
	CARD_TONE,
	cardAwaitingResult,
	cardBottom,
	cardInnerWidth,
	cardLine,
	cardTop,
	floatRows,
	markCardResult,
} from "__GS_UI_BETTER_SHELL_CARD__";

const BASH_GLYPH = "$";
const MUSTACHE_ICON = "\u{f15de}";
const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

const RESOLVER_PATCHED = Symbol.for("gentle-shell.bash-one-line.resolver-patch");
const USER_MSG_PATCHED = Symbol.for("gentle-shell.user-message-box-patch");

type ThemeLike = {
	fg(token: string, text: string): string;
	bg?(token: string, text: string): string;
};

function getActiveTheme(): ThemeLike {
	try {
		const t = (globalThis as Record<symbol, ThemeLike>)[
			Symbol.for("@earendil-works/pi-coding-agent:theme")
		];
		if (t && typeof t.fg === "function") return t;
	} catch {
		/* fallback */
	}
	return { fg: (_tok, s) => s };
}

function paint(theme: ThemeLike, token: string, text: string): string {
	try {
		return theme.fg(token, text);
	} catch {
		return text;
	}
}

const ANSI_RE = /\x1b(?:\x5d[^\x07\x1b]*(?:\x07|\x1b\x5c)|\[[0-?]*[ -/]*[@-~]|[@-Z\x5c-_])/g;
const CONTROL_RE = /[\x00-\x1f\x7f]/g;

function sanitizeInline(text: string): string {
	return text.replace(ANSI_RE, "").replace(CONTROL_RE, " ");
}

// Deterministic, zero-cost statement: the command's first verb names the task,
// so the card reads like an action instead of a command line. Nothing is
// invented — an unmatched command keeps its own first line, clipped by the card.
const GIT_PHRASES: Record<string, string> = {
	status: "git status",
	diff: "git diff",
	log: "git log",
	show: "git show",
	add: "stage files",
	commit: "commit",
	push: "push",
	pull: "pull",
	fetch: "fetch",
	checkout: "checkout",
	switch: "switch branch",
	branch: "branches",
	stash: "stash",
	rebase: "rebase",
	merge: "merge",
	worktree: "worktrees",
	remote: "remotes",
};

const SCRIPT_PHRASES: Record<string, string> = {
	test: "run tests",
	t: "run tests",
	build: "build",
	install: "install dependencies",
	i: "install dependencies",
	add: "install dependencies",
	dev: "start dev server",
	start: "start dev server",
	lint: "lint",
	typecheck: "typecheck",
};

function firstOperand(tokens: readonly string[]): string {
	const token = tokens.find((candidate) => candidate !== "" && !candidate.startsWith("-")) ?? "";
	// A quoted pattern reads better without the quotes the shell needed.
	const unquoted = token.replace(/^(['"])([\s\S]*)\1$/, "$2");
	return sanitizeInline(unquoted);
}

// A chain names its first real action: `rm -rf x; pgrep ...; echo ...` is a
// removal, and the count says how much more ran behind it.
function splitSegments(command: string): string[] {
	const segments: string[] = [];
	let current = "";
	let quote = "";
	for (let index = 0; index < command.length; index++) {
		const char = command[index] ?? "";
		if (quote !== "") {
			current += char;
			if (char === quote) quote = "";
			continue;
		}
		if (char === "'" || char === '"') { quote = char; current += char; continue; }
		if (char === "\\") { current += char + (command[index + 1] ?? ""); index++; continue; }
		if (char === ";" || char === "\n" || char === "|" || char === "&") {
			segments.push(current);
			current = "";
			if ((char === "|" || char === "&") && command[index + 1] === char) index++;
			continue;
		}
		current += char;
	}
	segments.push(current);
	return segments.map((segment) => segment.trim()).filter((segment) => segment !== "");
}

function dropRedirection(segment: string): string {
	return segment
		.replace(/\s+\d?&?>>?\s*(?:&?\d|\/dev\/\S+|\S+)/g, "")
		.replace(/\s+\d?>&\d+/g, "")
		.trim();
}

// Setup steps (cd, export, set -a, sourcing an env file) never name the task.
const SETUP_TOOLS = /^(?:cd|pushd|popd|export|unset|set|source|\.|exec)$/;

function toolOf(segment: string): string {
	const head = dropRedirection(segment).split(/\s+/).find((token) => token !== "") ?? "";
	return head.replace(/^.*\//, "");
}

function phraseFor(segment: string): string {
	const cleaned = dropRedirection(segment);
	const [head = "", ...args] = cleaned.split(/\s+/).filter((token) => token !== "");
	const tool = head.replace(/^.*\//, "");
	// A wrapper never names the action: look through it.
	if (/^(?:sudo|doas|time|env|command|nohup|nice)$/.test(tool)) return phraseFor(args.join(" "));
	const operand = firstOperand(args);
	const withOperand = (phrase: string) => (operand === "" ? phrase : `${phrase} ${operand}`);

	if (/^(?:rg|grep|ag|ack)$/.test(tool)) return withOperand("search");
	if (/^(?:fd|fdfind|find)$/.test(tool)) return withOperand("find files");
	if (/^(?:ls|eza|exa|tree|ll)$/.test(tool)) return withOperand("list");
	if (/^(?:bat|batcat|cat|head|tail|less|more)$/.test(tool)) return withOperand("read");
	if (tool === "git") {
		const sub = args.find((token) => token !== "" && !token.startsWith("-")) ?? "";
		return GIT_PHRASES[sub] ?? (sub === "" ? "git" : `git ${sub}`);
	}
	if (/^(?:pnpm|npm|yarn|bun|npx)$/.test(tool)) {
		const script = args.find((token) => token in SCRIPT_PHRASES);
		return script === undefined ? [tool, operand].filter((part) => part !== "").join(" ") : SCRIPT_PHRASES[script];
	}
	if (tool === "go") {
		const sub = args[0] ?? "";
		if (sub === "test") return "run tests";
		if (sub === "build") return "build";
		if (sub === "run") return "run";
		if (sub === "vet") return "vet";
	}
	if (/^(?:rm|rmdir)$/.test(tool)) return withOperand("remove");
	if (tool === "mkdir") return withOperand("create dir");
	if (tool === "mv") return withOperand("move");
	if (tool === "cp") return withOperand("copy");
	if (tool === "touch") return withOperand("touch");
	if (/^(?:chmod|chown)$/.test(tool)) return withOperand("permissions");
	if (/^(?:sed|awk|sd)$/.test(tool)) return withOperand("edit");
	if (/^(?:echo|printf)$/.test(tool)) return "print";
	if (/^(?:pgrep|pkill|kill|killall|ps|top)$/.test(tool)) return "processes";
	if (tool === "tmux") return `tmux ${args[0] ?? ""}`.trim();
	if (/^(?:python|python3)$/.test(tool)) return withOperand("run python");
	if (/^(?:node|tsx|deno|bunx)$/.test(tool)) return withOperand("run node");
	if (/^(?:pip|pip3|uv)$/.test(tool)) return "python packages";
	if (/^(?:psql|mysql|sqlcmd|mssql)$/.test(tool)) return "query database";
	if (/^(?:ssh|scp|rsync)$/.test(tool)) return "remote";
	if (tool === "journalctl") return "logs";
	if (/^(?:tar|zip|unzip|gzip|gunzip)$/.test(tool)) return "archive";
	if (tool === "ln") return withOperand("link");
	if (tool === "wc") return "count";
	if (tool === "jq") return withOperand("json");
	if (/^(?:curl|wget)$/.test(tool)) return withOperand("fetch");
	if (tool === "systemctl") return "services";
	if (/^(?:pacman|yay|paru)$/.test(tool)) return "packages";
	if (/^(?:docker|podman)$/.test(tool)) return "containers";
	return cleaned;
}

function summarize(command: string): string {
	const segments = splitSegments(command);
	if (segments.length === 0) return "";
	let index = 0;
	while (index < segments.length && SETUP_TOOLS.test(toolOf(segments[index] ?? ""))) index++;
	if (index >= segments.length) index = 0;
	const primary = phraseFor(segments[index] ?? "");
	const extras = segments.length - index - 1;
	return extras > 0 ? `${primary} (+${extras} more)` : primary;
}

function describeCommand(command: string): { statement: string; fromIntent: boolean } {
	const intentMatch = /^#\s*intent:\s*(.+)$/im.exec(command);
	if (intentMatch) {
		return { statement: sanitizeInline(intentMatch[1].trim()), fromIntent: true };
	}
	return { statement: sanitizeInline(summarize(command.trim())), fromIntent: false };
}

function formatDuration(durationMs?: number): string {
	if (typeof durationMs !== "number") return "";
	return durationMs < 1000 ? `${Math.round(durationMs)}ms` : `${(durationMs / 1000).toFixed(1)}s`;
}

function callCard(command: string, theme: ThemeLike, context: ToolRenderContext, width: number): string[] {
	const { statement, fromIntent } = describeCommand(command);
	const running = context.isPartial === true;
	const duration = formatDuration(context.durationMs);
	// Green for done (success), red for failed (error), amber for running (warning).
	const tone = running ? CARD_TONE.WARNING
		: context.isError === true ? CARD_TONE.ERROR : CARD_TONE.SUCCESS;
	const status = running
		? "running…"
		: `${context.isError === true ? "failed" : "done"}${duration === "" ? "" : ` · ${duration}`}`;
	// The tool name keeps the title role; the statement is muted unless the caller
	// declared an intent, which earns the champagne accent it always had.
	const title = `${paint(theme, "toolTitle", "bash")} ${paint(theme, fromIntent ? "toolTitle" : "muted", statement)}`;
	return floatRows(tone, theme, width, (inner) => ({
		head: [cardTop({ title, body: [], tone, glyph: BASH_GLYPH }, theme, inner, running ? undefined : "ctrl+o")],
		body: [],
		bottom: cardBottom(tone, theme, inner, status),
	}));
}

class CardRows implements Component {
	private readonly build: (width: number) => string[];

	constructor(build: (width: number) => string[]) {
		this.build = build;
	}

	render(width: number): string[] {
		return this.build(Math.max(1, Math.floor(width)));
	}

	invalidate(): void {
		/* Rebuilt dynamically. */
	}
}

// Reuse Pi's fallback formatting, sanitization and image indicators instead of
// maintaining a second copy. These methods are runtime internals, like the
// resolver patch below; recheck compatibility when upgrading Pi.
const nativeFallback = ToolExecutionComponent.prototype as unknown as {
	createCallFallback(this: { toolName: string; args: unknown; expanded: boolean }): Component;
	createResultFallback(this: { expanded: boolean; getTextOutput(): string }): Component | undefined;
	getTextOutput(this: { result: unknown; showImages: boolean }): string;
};
const ORIGINAL_COMPONENT = Symbol.for("gentle-shell.tool-card.original-component");

type MouseEvent = Parameters<NonNullable<Component["handleMouse"]>>[0];

class ToolCardPart implements Component {
	readonly [ORIGINAL_COMPONENT]: Component | undefined;
	private hitRows: { x: number; y: number; width: number }[] = [];

	constructor(
		child: Component | undefined,
		private readonly toolName: string,
		private readonly theme: ThemeLike,
		private readonly context: ToolRenderContext,
		private readonly part: "call" | "result",
	) {
		this[ORIGINAL_COMPONENT] = child;
	}

	render(width: number): string[] {
		const target = Math.max(0, Math.floor(width));
		this.hitRows = [];
		if (target === 0) return [];
		const tone = this.context.isError ? CARD_TONE.ERROR
			: this.context.isPartial ? CARD_TONE.WARNING : CARD_TONE.INFO;
		return floatRows(tone, this.theme, target, (inner) => {
			// Leave room for the heading's glyph and frame so no call text is lost.
			const columns = this.part === "call" ? Math.max(1, inner - 8) : cardInnerWidth(inner);
			const rows = this[ORIGINAL_COMPONENT]?.render(columns) ?? [];
			const margin = (target - inner) / 2;
			const floatPadding = margin > 0 ? 1 : 0;
			if (this.part === "call") {
				const [title = this.toolName, ...body] = rows;
				const top = cardTop({ title, body: [], tone, glyph: "≡" }, this.theme, inner);
				const plainTop = sanitizeInline(top);
				const titleAt = plainTop.indexOf(sanitizeInline(title));
				this.hitRows = rows.map((_row, i) => ({
					x: margin + (i === 0 ? Math.max(0, titleAt) : 2),
					y: floatPadding + i + (i > 0 ? floatPadding : 0),
					width: columns,
				}));
				return {
					head: [top],
					body: body.map((line) => cardLine(line, tone, this.theme, inner)),
					bottom: cardAwaitingResult(this.context) ? cardBottom(tone, this.theme, inner) : undefined,
				};
			}
			this.hitRows = rows.map((_row, i) => ({ x: margin + 2, y: floatPadding + i, width: columns }));
			return {
				afterHeading: true,
				body: rows.map((line) => cardLine(line, tone, this.theme, inner)),
				bottom: cardBottom(tone, this.theme, inner),
			};
		});
	}

	invalidate(): void { this[ORIGINAL_COMPONENT]?.invalidate(); }

	handleMouse(event: MouseEvent): ReturnType<NonNullable<Component["handleMouse"]>> {
		const row = this.hitRows.findIndex((hit) => hit.y === event.y && event.x >= hit.x && event.x < hit.x + hit.width);
		if (row < 0) return undefined;
		const hit = this.hitRows[row];
		return this[ORIGINAL_COMPONENT]?.handleMouse?.({ ...event, x: event.x - hit.x, y: row, width: hit.width, height: this.hitRows.length });
	}
}

function originalContext(context: ToolRenderContext): ToolRenderContext {
	const previous = context.lastComponent as (Component & { [ORIGINAL_COMPONENT]?: Component }) | undefined;
	return previous && ORIGINAL_COMPONENT in previous
		? { ...context, lastComponent: previous[ORIGINAL_COMPONENT] }
		: context;
}

function styleDefaultTool(toolName: string, original: ToolRenderers | undefined): ToolRenderers {
	if (original?.renderShell === "self") return original;
	return {
		...original,
		renderShell: "self",
		renderCall(args, theme, context) {
			const fallback = () => nativeFallback.createCallFallback.call({ toolName, args, expanded: context.expanded });
			let child: Component;
			try { child = original?.renderCall?.(args, theme, originalContext(context)) ?? fallback(); }
			catch { child = fallback(); }
			return new ToolCardPart(child, toolName, theme, context, "call");
		},
		renderResult(result, options, theme, context) {
			markCardResult(context.state);
			const fallback = () => nativeFallback.createResultFallback.call({
				expanded: options.expanded,
				getTextOutput: () => nativeFallback.getTextOutput.call({ result, showImages: context.showImages }),
			});
			let child: Component | undefined;
			try { child = original?.renderResult?.(result, options, theme, originalContext(context)) ?? fallback(); }
			catch { child = fallback(); }
			return new ToolCardPart(child, toolName, theme, context, "result");
		},
	};
}

function renderUserMessageBox(rawText: string, width: number, theme: ThemeLike): string[] {
	const target = Math.max(0, Math.floor(width));
	if (target === 0) return [];
	if (target < 10) return wrapTextWithAnsi(rawText.trim(), target).map((line) => paint(theme, "accent", line));
	const icon = paint(theme, "borderAccent", MUSTACHE_ICON);
	const border = (s: string) => paint(theme, "borderAccent", s);
	const style = (globalThis as Record<symbol, unknown>)[Symbol.for("gentle-pi.card-style")];

	// The same process-wide style slot and panel role used by Gentle's input.
	if (style !== "neon" && theme.bg) {
		try {
			const innerWidth = target - 5;
			const background = theme.bg.bind(theme);
			const row = (content: string) => {
				const padded = content + " ".repeat(Math.max(0, innerWidth - visibleWidth(content)));
				return ` ${background("toolSuccessBg", `${border("▎")} ${padded} `)} `;
			};
			// The mustache glyph bleeds into the next cell in Nerd fonts, so a single
			// space is swallowed: it keeps a wider gap than a plain ASCII marker.
			// Continuation rows align under the text, not under the icon.
			const gap = "  ";
			const indent = " ".repeat(visibleWidth(icon) + visibleWidth(gap));
			const textWidth = Math.max(10, innerWidth - visibleWidth(indent));
			const wrapped = wrapTextWithAnsi(rawText.trim(), textWidth);
			return [
				row(""), // The icon/text row needs the same top breathing room as other float cards.
				...(wrapped.length > 0 ? wrapped : [""]).map((line, index) => row(index === 0
					? `${icon}${gap}${paint(theme, "accent", line)}`
					: paint(theme, "accent", `${indent}${line}`))),
				row(""),
			];
		} catch { /* Themes without a usable panel background retain the neon outline. */ }
	}

	// Two blank cells on each side keep the mustache clear of both rule segments.
	const title = `  ${icon}  `;
	const remainingRule = Math.max(0, target - 3 - visibleWidth(title));
	const topRule = `${border("╭─")}${title}${border("─".repeat(remainingRule) + "╮")}`;
	const innerWidth = target - 4;
	const wrapped = wrapTextWithAnsi(rawText.trim(), innerWidth);
	const bodyLines = (wrapped.length > 0 ? wrapped : [""]).map((line) => {
		const pad = Math.max(0, innerWidth - visibleWidth(line));
		return `${border("│ ")}${paint(theme, "accent", line)}${" ".repeat(pad)}${border(" │")}`;
	});
	return [topRule, ...bodyLines, border(`╰${"─".repeat(target - 2)}╯`)];
}

// ---------------------------------------------------------------------------
// Assistant replies: a closed champagne box with a glyph, on the live style.
// The glyph is a wide geometric mark, never the mustache (that one is the user)
// and never an emoji: double-width cells would break the rail budget.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Assistant answers: the final answer carries a marker. neon closes a bare
// outline; float paints the same rail surface the user card uses, because a
// drawn box on a filled card reads as a frame inside a card. The thinking run
// is never framed: it is not the answer.
// ---------------------------------------------------------------------------

const ASSISTANT_MARK = "\u276f";
const ASSISTANT_WORD = "ANSWER";
// One stable slot holds the pristine render forever, so a reload (or a package version
// change) can never stack a second frame on top of the first one.
const ASSISTANT_RENDER_ORIGINAL = Symbol.for("gentle-shell.assistant-render-original");
const CUSTOM_NEON_PATCHED = Symbol.for("gentle-shell.custom-message-neon-frame-original");
// gentle-pi tags its own editor factory; a wrapper that keeps the tag is accepted on the next
// session_start and is rebuilt from the same deps, so the mutation below survives every reload.
const PROMPT_OWNER = Symbol.for("gentle-pi.prompt-owner");
const PROMPT_FLOAT_INSTALLED = Symbol.for("gentle-shell.prompt-float-in-fullscreen");
const CARD_STYLE_SLOT = Symbol.for("gentle-pi.card-style");
const ASSISTANT_FRAME_CACHE = Symbol.for("gentle-shell.assistant-frame-cache");
// Earlier versions stored a render under their own slot during the handover. They are read
// OLDEST first: the first version stored the pristine function, and every later one stored a
// function that already carried the previous frame, so the oldest slot is the only clean one.
const ASSISTANT_HANDOVER_SLOTS = [
	Symbol.for("gentle-shell.assistant-reply-box-patch"),
	Symbol.for("gentle-shell.assistant-answer-frame-patch"),
];
// Gentleman-Cute carries `deepPink` as a theme variable, not as a color token:
// theme.fg("deepPink") throws "Unknown theme color". The literal holds the exact
// value that theme declares (#C96AA2), and any theme that gains the token wins first.
const ASSISTANT_FRAME_RGB = "201;106;162";

/** The open/close sequence one background token wraps text with, for re-arming a row. */
function backgroundParts(theme: ThemeLike, token: string): { open: string; close: string } | undefined {
	if (typeof theme.bg !== "function") return undefined;
	const SENTINEL = "\u0001";
	try {
		const wrapped = theme.bg(token, SENTINEL);
		const at = wrapped.indexOf(SENTINEL);
		if (at < 0) return undefined;
		return { open: wrapped.slice(0, at), close: wrapped.slice(at + SENTINEL.length) };
	} catch {
		return undefined;
	}
}

// A body line carries its own colors (markdown, code, links): every reset it emits
// would drop the row background, so the background is re-opened right after it.
function rearmBackground(open: string, line: string): string {
	return line.replace(/\x1b\[(?:0|49)m/g, (match) => match + open);
}

/**
 * Hard-wraps any line that overflows its budget, so a long token can never push a
 * frame past the terminal width. Undefined means the budget cannot host the frame.
 */
function fitLines(lines: string[], innerWidth: number): string[] | undefined {
	const fitted = lines.flatMap((line) =>
		visibleWidth(line) > innerWidth ? wrapTextWithAnsi(line, innerWidth) : [line]);
	return fitted.some((line) => visibleWidth(line) > innerWidth) ? undefined : fitted;
}

/** A closed outline for neon, where there is no surface to lean on. */
function neonFrame(fitted: string[], innerWidth: number, target: number, border: (text: string) => string, renderedTitle: string): string[] {
	const topRule = border("\u256d\u2500") + renderedTitle
		+ border(`${"\u2500".repeat(Math.max(0, target - 3 - visibleWidth(renderedTitle)))}` + "\u256e");
	const bottomRule = border(`\u2570${"\u2500".repeat(Math.max(0, target - 2))}\u256f`);
	const rows = fitted.map((line) => {
		const pad = Math.max(0, innerWidth - visibleWidth(line));
		return `${border("\u2502 ")}${line}${" ".repeat(pad)}${border(" \u2502")}`;
	});
	return [topRule, ...rows, bottomRule];
}

/**
 * Resolves the frame color once per render. Probing the token with a try/catch per row
 * would throw once per row (this theme has no `deepPink` token), which is measurable.
 */
function framePainter(theme: ThemeLike): (text: string) => string {
	try {
		theme.fg("deepPink", "x");
		return (text: string) => theme.fg("deepPink", text);
	} catch {
		return (text: string) => `\x1b[38;2;${ASSISTANT_FRAME_RGB}m${text}\x1b[39m`;
	}
}

/**
 * Draws the answer marker over the lines of the final text block.
 * Returns the lines unchanged when the column budget cannot host the frame.
 */
function renderAssistantAnswer(bodyLines: string[], width: number, theme: ThemeLike): string[] {
	const target = Math.max(0, Math.floor(width));
	if (target < 24 || bodyLines.length === 0) return bodyLines;

	const style = (globalThis as Record<symbol, unknown>)[Symbol.for("gentle-pi.card-style")];
	const isFloat = style !== "neon";
	const frame = framePainter(theme);
	const innerWidth = target - 4;
	if (innerWidth < 6) return bodyLines;

	const fitted = fitLines(bodyLines, innerWidth);
	if (!fitted) return bodyLines;

	const markTitle = ` ${ASSISTANT_MARK} ${ASSISTANT_WORD} `;
	const markOnly = ` ${ASSISTANT_MARK} `;

	if (isFloat) {
		// Float: one blank column each side, a pearl rail, and the marker on its own row.
		const background = backgroundParts(theme, "customMessageBg");
		// Without a usable surface a rail card is a frame in disguise: keep the native lines.
		if (!background) return bodyLines;
		// The rail rides inside the four reserved columns, so the body keeps the full inner width.
		const contentWidth = innerWidth;
		if (contentWidth < 6) return bodyLines;

		const rail = frame("\u258e ");
		const row = (content: string) => {
			const pad = Math.max(0, contentWidth - visibleWidth(content));
			const inner = rail + content + " ".repeat(pad);
			return ` ${background.open}${rearmBackground(background.open, inner)}${background.close} `;
		};

		const label = contentWidth >= visibleWidth(markTitle)
			? frame(`${ASSISTANT_MARK} ${ASSISTANT_WORD}`)
			: contentWidth >= visibleWidth(markOnly.trim()) ? frame(ASSISTANT_MARK) : "";
		const rows = [row("")];
		if (label !== "") rows.push(row(label));
		rows.push(...fitted.map((line) => row(line)));
		rows.push(row(""));
		return rows;
	}

	// Neon: a bare closed outline, no surface.
	const label = target - 3 - visibleWidth(markTitle) >= 2
		? markTitle
		: target - 3 - visibleWidth(markOnly) >= 2 ? markOnly : "";
	const rendered = label === markTitle
		? ` ${frame(ASSISTANT_MARK)} ${frame(ASSISTANT_WORD)} `
		: label === markOnly ? ` ${frame(ASSISTANT_MARK)} ` : "";
	return neonFrame(fitted, innerWidth, target, frame, rendered);
}

type PromptEditorDeps = { panelChrome?: () => boolean };
type PromptEditor = { deps?: PromptEditorDeps };
type PromptFactory = ((tui: unknown, theme: unknown, keybindings: unknown) => PromptEditor) & {
	[key: symbol]: unknown;
};

/**
 * In fullscreen the panel layout replaces the prompt, so float never reaches the screen.
 * Flipping panelChrome per editor instance hands the job back to gentle-pi's own float
 * layout: its prefix width, mouse mapping and cursor math stay native. neon keeps the panel.
 */
function installPromptFloat(ui: unknown): boolean {
	const surface = ui as { getEditorComponent?: () => PromptFactory | undefined; setEditorComponent?: (factory: PromptFactory) => void } | undefined;
	if (!surface || typeof surface.getEditorComponent !== "function" || typeof surface.setEditorComponent !== "function") return false;
	const previous = surface.getEditorComponent();
	// Before gentle-pi installs its editor there is nothing to wrap; leave the slot alone.
	if (!previous || previous[PROMPT_OWNER] !== true) return false;
	if (previous[PROMPT_FLOAT_INSTALLED] === true) return true;

	const wrapper = ((tui: unknown, theme: unknown, keybindings: unknown) => {
		const editor = previous(tui, theme, keybindings);
		const deps = editor?.deps;
		if (deps && typeof deps === "object") {
			// Read live: the card style can change at runtime without rebuilding the editor.
			deps.panelChrome = () => (globalThis as Record<symbol, unknown>)[CARD_STYLE_SLOT] === "neon";
		}
		return editor;
	}) as PromptFactory;
	wrapper[PROMPT_OWNER] = true;
	wrapper[PROMPT_FLOAT_INSTALLED] = true;
	surface.setEditorComponent(wrapper);
	return true;
}

export default function bashOneLine(_pi: ExtensionAPI): void {
	// 1. Draw the bash card; style every other default-shell tool.
	const runnerProto = ExtensionRunner.prototype as unknown as {
		[RESOLVER_PATCHED]?: (toolName: string, base: () => unknown) => unknown;
		resolveToolRenderers: (toolName: string, base: () => unknown) => unknown;
	};

	const baseResolve = runnerProto[RESOLVER_PATCHED] ?? runnerProto.resolveToolRenderers;
	runnerProto[RESOLVER_PATCHED] = baseResolve;

	// Always assign fresh function on reload so code updates take effect immediately
	runnerProto.resolveToolRenderers = function (this: unknown, toolName: string, base: () => unknown) {
		if (toolName === "bash") {
			const original = baseResolve.call(this, "bash", base) as {
				renderCall?: (args: unknown, theme: ThemeLike, context: ToolRenderContext) => Component;
				renderResult?: (result: unknown, options: { expanded: boolean; isPartial: boolean }, theme: ThemeLike, context: ToolRenderContext) => Component;
			} | undefined;

			return {
				renderShell: "self",
				renderCall(args: unknown, theme: ThemeLike, context: ToolRenderContext) {
					if (context.expanded === true && original?.renderCall) {
						return original.renderCall(args, theme, context);
					}
					const command = typeof (args as { command?: unknown })?.command === "string"
						? (args as { command: string }).command
						: "";
					return new CardRows((width) => callCard(command, theme, context, width));
				},
				renderResult(result: unknown, options: { expanded: boolean; isPartial: boolean }, theme: ThemeLike, context: ToolRenderContext) {
					if (options.expanded === true && original?.renderResult) {
						return original.renderResult(result, options, theme, context);
					}
					return new Text("", 0, 0);
				},
			};
		}
		const original = baseResolve.call(this, toolName, base) as ToolRenderers | undefined;
		return styleDefaultTool(toolName, original);
	};

	// 2. User message card: mustache inline in float, in the top rule in neon.
	const userMsgProto = UserMessageComponent.prototype as unknown as {
		[USER_MSG_PATCHED]?: (width: number) => string[];
		render: (width: number) => string[];
	};

	const origUserRender = userMsgProto[USER_MSG_PATCHED] ?? userMsgProto.render;
	userMsgProto[USER_MSG_PATCHED] = origUserRender;

	// Always assign fresh render on reload so box updates take effect immediately
	userMsgProto.render = function (this: { text?: string }, width: number): string[] {
		const currentTheme = getActiveTheme();
		const rawText = typeof this.text === "string" ? this.text : "";
		const lines = renderUserMessageBox(rawText, width, currentTheme);
		if (lines.length > 0) {
			lines[0] = OSC133_ZONE_START + lines[0];
			lines[lines.length - 1] = OSC133_ZONE_END + OSC133_ZONE_FINAL + lines[lines.length - 1];
		}
		return lines;
	};

	// 3. Assistant answers: frame only the final text block, never the thinking run.
	const assistantProto = AssistantMessageComponent.prototype as unknown as {
		render: (width: number) => string[];
	};
	type MarkdownSlot = { kind: string; markdown?: { render: (width: number) => string[] } };
	type AssistantSelf = {
		markdownSlots?: MarkdownSlot[];
		hasToolCalls?: boolean;
		isStreaming?: boolean;
		lastMessage?: unknown;
	};

	const slots = assistantProto as unknown as Record<symbol, ((width: number) => string[]) | undefined>;
	const handover = ASSISTANT_HANDOVER_SLOTS.map((slot) => slots[slot]).find((fn) => typeof fn === "function");
	const origAssistantRender = slots[ASSISTANT_RENDER_ORIGINAL] ?? handover ?? assistantProto.render;
	slots[ASSISTANT_RENDER_ORIGINAL] = origAssistantRender;

	// Always assign fresh render on reload so frame updates take effect immediately
	assistantProto.render = function (this: unknown, width: number): string[] {
		const self = this as AssistantSelf;
		const target = Math.max(0, Math.floor(width));
		const themeNow = getActiveTheme();
		const styleNow = (globalThis as Record<symbol, unknown>)[Symbol.for("gentle-pi.card-style")];
		// The host repaints the whole transcript on every keystroke. A finished message renders
		// identically until width, style or theme change, so it is cached; the streaming one never is.
		const slot = this as unknown as Record<symbol, unknown>;
		const cacheable = self.isStreaming !== true;
		const cached = slot[ASSISTANT_FRAME_CACHE] as
			{ message: unknown; width: number; style: unknown; theme: unknown; out: string[] } | undefined;
		// The host rewrites the returned line array in place, so a cached frame is copied out
		// and stored from a copy; handing the same array back would corrupt it.
		if (cacheable && cached && cached.message === self.lastMessage && cached.width === target
			&& cached.style === styleNow && cached.theme === themeNow) return cached.out.slice();
		const paint = (): string[] => {
		if (target < 24) return origAssistantRender.call(this, target);
		// One width for the whole message keeps Markdown's per-width cache warm across frames.
		// Rendering at two alternating widths re-renders every frame (measured 78x slower).
		const bodyWidth = target - 4;
		if (bodyWidth < 10) return origAssistantRender.call(this, target);
		// A message that also carries tool calls is still an answer: only its width can stop the frame.
		// The head keeps the full target width; only the framed tail is narrowed.
		const native = origAssistantRender.call(this, target);
		if (native.length === 0) return native;

		const slots = self.markdownSlots;
		if (!Array.isArray(slots)) return native;
		const lastText = slots.filter((slot) => slot.kind === "text").at(-1);
		if (!lastText?.markdown) return native;

		// Two widths, paid once per content change: the cache covers every repaint afterwards
		// (measured 0.001 ms repaint, 1.40 ms new paint, equal to the single-width path).
		const bodyAtFull = lastText.markdown.render(target);
		const count = bodyAtFull.length;
		if (count === 0 || count >= native.length) return native;
		const matches = native.slice(native.length - count)
			.map(sanitizeInline).join("\n").trimEnd() === bodyAtFull.map(sanitizeInline).join("\n").trimEnd();
		const body = lastText.markdown.render(bodyWidth);
		if (!matches) return native;

		const head = native.slice(0, native.length - count);
		// Both styles reserve four columns: the outline in neon, the margins and rail in float.
		const framed = renderAssistantAnswer(body, target, getActiveTheme());
		if (framed === body) return native;

		// The native render owns the prompt zones and skips them when the message carries tool calls;
		// the frame moves the last row, so they are re-applied only when the native render set them.
		const out = [...head, ...framed];
		if (!native[0].includes(OSC133_ZONE_START)) return out;
		const stripZone = (line: string) => line.split(OSC133_ZONE_START).join("").split(OSC133_ZONE_END).join("").split(OSC133_ZONE_FINAL).join("");
		const zoned = [...head.map(stripZone), ...framed];
		if (zoned.length === 0) return native;
		zoned[0] = OSC133_ZONE_START + zoned[0];
		zoned[zoned.length - 1] = OSC133_ZONE_END + OSC133_ZONE_FINAL + zoned[zoned.length - 1];
		return zoned;
		};
		const out = paint();
		if (cacheable) {
			slot[ASSISTANT_FRAME_CACHE] = { message: self.lastMessage, width: target, style: styleNow, theme: themeNow, out: out.slice() };
		}
		return out;
	};

	// 4. Runtime notices ([gentle-pi.exploration-budget] and friends): neon closes them in the
	// same outline, because neon has no surface. Float already paints its own card: untouched.
	const customProto = CustomMessageComponent.prototype as unknown as {
		render: (width: number) => string[];
	};
	const customSlots = customProto as unknown as Record<symbol, ((width: number) => string[]) | undefined>;
	const origCustomRender = customSlots[CUSTOM_NEON_PATCHED] ?? customProto.render;
	customSlots[CUSTOM_NEON_PATCHED] = origCustomRender;

	// Always assign fresh render on reload so frame updates take effect immediately
	customProto.render = function (this: unknown, width: number): string[] {
		const target = Math.max(0, Math.floor(width));
		const native = origCustomRender.call(this, target);
		if (target < 24 || native.length === 0) return native;
		const style = (globalThis as Record<symbol, unknown>)[Symbol.for("gentle-pi.card-style")];
		// Float draws its own card surface; only the bare neon outline needs a frame here.
		if (style !== "neon") return native;
		const innerWidth = target - 4;
		const fitted = fitLines(native, innerWidth);
		if (!fitted) return native;
		return neonFrame(fitted, innerWidth, target, framePainter(getActiveTheme()), "");
	};

	// 5. Prompt: float inside fullscreen, neon untouched. gentle-pi may install its editor
	// after this extension loads, so the installer is retried on the next turn.
	const tryPrompt = (ctx: unknown) => installPromptFloat((ctx as { ui?: unknown } | undefined)?.ui);
	_pi.on("session_start", (_event: unknown, ctx: unknown) => { tryPrompt(ctx); });
	_pi.on("before_agent_start", (_event: unknown, ctx: unknown) => { tryPrompt(ctx); });
}
