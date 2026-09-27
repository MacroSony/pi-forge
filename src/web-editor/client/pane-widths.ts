/** Browser-only layout preferences. Never reads or changes a Preset draft. */
const STORAGE_KEY = "pi-forge-pane-widths-v1";
const SIZES = {
	presets: { default: 212, min: 180, max: 400 },
	items: { default: 190, min: 160, max: 420 },
} as const;
type Pane = keyof typeof SIZES;
const EDITOR_MIN = 240;
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, Math.round(value)));

export function startPaneWidths(shell: HTMLElement): () => void {
	const workspace = shell.querySelector<HTMLElement>("#workspace")!;
	const dock = shell.querySelector<HTMLElement>("#editorDockArea")!;
	const handles = {
		presets: shell.querySelector<HTMLElement>("#presetWidthHandle")!,
		items: shell.querySelector<HTMLElement>("#stackWidthHandle")!,
	};
	const widths: Record<Pane, number> = { presets: SIZES.presets.default, items: SIZES.items.default };
	try {
		const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
		for (const key of Object.keys(SIZES) as Pane[]) {
			if (typeof saved?.[key] === "number" && Number.isFinite(saved[key])) {
				widths[key] = clamp(saved[key], SIZES[key].min, SIZES[key].max);
			}
		}
	} catch { /* Storage may be blocked or contain an older/invalid value. */ }

	const desktop = window.matchMedia("(min-width: 801px)");
	const events = new AbortController();
	let frame = 0;
	let stopped = false;
	let drag: { key: Pane; pointerId: number; x: number; width: number; previous: number } | undefined;

	function save(): void {
		try { localStorage.setItem(STORAGE_KEY, JSON.stringify(widths)); } catch { /* In-page resizing still works. */ }
	}
	function bounds(key: Pane): { min: number; max: number } {
		const size = SIZES[key];
		// The inspector owns its own layout. Measure its current allocation rather
		// than changing its side/wide/focus state or responsive stacking rules.
		const columns = getComputedStyle(dock).gridTemplateColumns.trim().split(/\s+/);
		const inspector = columns.length === 2 ? Number.parseFloat(columns[1]) || 0 : 0;
		const available = key === "presets"
			? shell.clientWidth - inspector - SIZES.items.min - EDITOR_MIN
			: workspace.clientWidth - EDITOR_MIN;
		return { min: size.min, max: Math.max(size.min, Math.min(size.max, Math.floor(available))) };
	}
	function setWidth(target: HTMLElement, property: string, value: number): void {
		const text = `${value}px`;
		if (target.style.getPropertyValue(property) !== text) target.style.setProperty(property, text);
	}
	function apply(): void {
		if (stopped) return;
		if (!desktop.matches || !shell.getClientRects().length) {
			finish(false);
			return;
		}
		for (const key of Object.keys(SIZES) as Pane[]) {
			const { min, max } = bounds(key);
			const value = clamp(widths[key], min, max);
			// A hidden workspace has no usable bounds. Keep its requested width
			// until it becomes visible; clamping never overwrites saved preferences.
			if (key === "items" && !workspace.getClientRects().length) continue;
			setWidth(key === "presets" ? shell : workspace,
				key === "presets" ? "--preset-pane-width" : "--stack-pane-width", value);
			handles[key].setAttribute("aria-valuemin", String(min));
			handles[key].setAttribute("aria-valuemax", String(max));
			handles[key].setAttribute("aria-valuenow", String(value));
		}
		if (drag && !handles[drag.key].getClientRects().length) finish(false);
	}
	function schedule(): void {
		if (!stopped && !frame) frame = requestAnimationFrame(() => { frame = 0; apply(); });
	}
	function finish(commit: boolean): void {
		if (!drag) return;
		const previous = drag;
		drag = undefined;
		if (commit) save();
		else widths[previous.key] = previous.previous;
		shell.classList.remove("pane-width-dragging");
		const handle = handles[previous.key];
		if (handle.hasPointerCapture(previous.pointerId)) handle.releasePointerCapture(previous.pointerId);
		schedule();
	}
	function reset(key: Pane): void {
		finish(false);
		widths[key] = SIZES[key].default;
		apply();
		save();
	}

	for (const key of Object.keys(SIZES) as Pane[]) {
		const handle = handles[key];
		handle.addEventListener("pointerdown", (event) => {
			if (!desktop.matches || event.button !== 0 || !event.isPrimary || drag) return;
			event.preventDefault();
			event.stopPropagation();
			shell.classList.add("pane-width-dragging");
			handle.focus({ preventScroll: true });
			drag = { key, pointerId: event.pointerId, x: event.clientX,
				width: handle.parentElement!.getBoundingClientRect().width, previous: widths[key] };
			handle.setPointerCapture(event.pointerId);
		}, { signal: events.signal });
		handle.addEventListener("pointermove", (event) => {
			if (!drag || drag.pointerId !== event.pointerId) return;
			const { min, max } = bounds(key);
			widths[key] = clamp(drag.width + event.clientX - drag.x, min, max);
			apply();
		}, { signal: events.signal });
		handle.addEventListener("pointerup", (event) => {
			if (drag?.pointerId === event.pointerId) finish(true);
		}, { signal: events.signal });
		for (const eventName of ["pointercancel", "lostpointercapture"] as const) {
			handle.addEventListener(eventName, () => finish(false), { signal: events.signal });
		}
		handle.addEventListener("dblclick", () => reset(key), { signal: events.signal });
		handle.addEventListener("keydown", (event) => {
			if (!desktop.matches || !["ArrowLeft", "ArrowRight", "Home", "End", "Enter"].includes(event.key)) return;
			event.preventDefault();
			event.stopPropagation();
			if (event.key === "Enter") { reset(key); return; }
			finish(false);
			const { min, max } = bounds(key);
			const current = Number(handle.getAttribute("aria-valuenow")) || widths[key];
			widths[key] = event.key === "Home" ? min : event.key === "End" ? max
				: clamp(current + (event.key === "ArrowLeft" ? -16 : 16), min, max);
			apply();
			save();
		}, { signal: events.signal });
	}
	window.addEventListener("keydown", (event) => {
		if (drag && event.key === "Escape") {
			event.preventDefault();
			event.stopPropagation();
			finish(false);
		}
	}, { signal: events.signal, capture: true });
	window.addEventListener("blur", () => finish(false), { signal: events.signal });
	window.addEventListener("resize", () => { finish(false); schedule(); }, { signal: events.signal });
	// Observer writes happen in rAF, not inside ResizeObserver delivery.
	const observer = new ResizeObserver(schedule);
	for (const element of [shell, dock, workspace]) observer.observe(element);
	apply();
	return () => {
		stopped = true;
		finish(false);
		events.abort();
		observer.disconnect();
		cancelAnimationFrame(frame);
		shell.style.removeProperty("--preset-pane-width");
		workspace.style.removeProperty("--stack-pane-width");
	};
}
