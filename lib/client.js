window.__ModuleLoader__.load({
	id: "dsh-workbuddy-connect",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		//#region src/status-paths.ts
		/** Node-free constants and types shared by the Host and browser halves. */
		/** Plugin-owned status endpoint consumed by its browser half. */
		const WORKBUDDY_STATUS_PATH = "/plugins/dsh-workbuddy-connect/status";
		/**
		* Plugin-owned probe control endpoint.
		*
		* Separate from the status route because it accepts writes: the status route's
		* loopback Host/Origin guard protects against a DNS-rebinding *page*, which is
		* not the same as authorizing a state-changing action. This route therefore
		* also requires the in-process key the browser half receives with the status
		* document.
		*/
		const WORKBUDDY_PROBE_PATH = "/plugins/dsh-workbuddy-connect/probe";
		/**
		* The international (WorkBuddy AI) variant's own pair of routes.
		*
		* Kept as separate constants rather than a computed suffix so both halves
		* reference literal strings: the browser bundle and the host bundle are built
		* independently, and a shared expression is one build-config drift away from
		* the desk asking a route the host never mounted.
		*/
		const WORKBUDDY_AI_STATUS_PATH = "/plugins/dsh-workbuddy-connect/ai/status";
		const WORKBUDDY_AI_PROBE_PATH = "/plugins/dsh-workbuddy-connect/ai/probe";
		/**
		* Same-origin route backing the browser's update reminder.
		*
		* Read-only like the status route, so the same loopback Host/Origin gate
		* applies; it answers public npm/GitHub metadata only and never token
		* material.
		*/
		const WORKBUDDY_UPDATE_PATH = "/plugins/dsh-workbuddy-connect/update";
		/** Every reason code, for validation without trusting a wire value. */
		const SIGNED_OUT_REASON_CODES = [
			"no-credential",
			"credential-region-mismatch",
			"encrypted-credential-unreadable",
			"electron-binary-not-found",
			"electron-binary-ambiguous",
			"electron-binary-unavailable",
			"electron-path-invalid",
			"electron-discovery-incomplete"
		];
		/** Whether a value is one of the closed set of signed-out reason codes. */
		function isWorkBuddySignedOutReasonCode(value) {
			return typeof value === "string" && SIGNED_OUT_REASON_CODES.includes(value);
		}
		//#endregion
		//#region src/client/status-document.ts
		/**
		* Whether a parsed status response really is a status document.
		*
		* A 200 is not a promise about the body: it may be empty, literal `null`, a
		* non-JSON page from a proxy, or an array. Both halves of the browser plugin
		* read the same route, so both must agree on what is valid — storing an
		* unreadable value puts something in state that the next render dereferences.
		*
		* The check is deliberately limited to the discriminator (plus `error`'s
		* `message`, which the error paragraph renders): validating optional fields
		* here would reject documents the host legitimately omits fields from.
		*
		* `reasonCode` is therefore *not* rejected here — a card renders `reason`
		* either way — but every reader must narrow it with
		* `isWorkBuddySignedOutReasonCode` before branching on it, since the wire
		* value is not guaranteed to be inside the enum.
		*/
		function isWorkBuddyWebStatus(value) {
			if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
			const wrapped = value;
			const status = wrapped["status"];
			if (status === "signed-out" || status === "signed-in") return true;
			return status === "error" && typeof wrapped["message"] === "string";
		}
		//#endregion
		//#region src/client/WorkBuddyPluginCard.tsx
		/**
		* WorkBuddy status card, rendered on whichever settings surface the host
		* provides: dispatched directly by DSH 0.1.5's settings Plugins tab (one card
		* per variant), or mounted by the bundle configuration page DSH 0.1.6+'s
		* Plugins page renders. The component itself is surface-agnostic — its props
		* are only the injected copy and variant.
		*/
		/** CN WorkBuddy; the plugin's long-standing card and default. */
		const CN_CARD_VARIANT = {
			id: "workbuddy",
			titleKey: "title",
			introKey: "intro",
			signedOutKey: "signedOutHint",
			statusPath: WORKBUDDY_STATUS_PATH,
			probePath: WORKBUDDY_PROBE_PATH,
			appName: "WorkBuddy",
			unavailableKey: "assistUnavailableCN"
		};
		/** International WorkBuddy AI. */
		const AI_CARD_VARIANT = {
			id: "workbuddy-ai",
			titleKey: "titleAI",
			introKey: "introAI",
			signedOutKey: "signedOutHintAI",
			statusPath: WORKBUDDY_AI_STATUS_PATH,
			probePath: WORKBUDDY_AI_PROBE_PATH,
			appName: "WorkBuddy AI",
			unavailableKey: "assistUnavailableAI"
		};
		/** Both cards, in display order. */
		const CARD_VARIANTS = [CN_CARD_VARIANT, AI_CARD_VARIANT];
		const POLL_INTERVAL_MS = 6e4;
		/**
		* The reason codes whose failures the Agent assist block covers: the plugin
		* cannot reach a decryption program, for any of the five reasons in §5.5.
		*
		* This is the *only* place the card decides whether the block applies. It
		* branches on the code, never on `reason` text: the prose is written for a
		* human and is expected to change, so matching it would silently stop
		* matching after any wording edit.
		*
		* `encrypted-credential-unreadable` is deliberately absent — the app was found
		* and ran, so "look for the app" is not the fix for it.
		*/
		const ASSIST_REASON_CODES = [
			"electron-binary-not-found",
			"electron-binary-ambiguous",
			"electron-binary-unavailable",
			"electron-path-invalid",
			"electron-discovery-incomplete"
		];
		/** Locale key for one failure's summary inside the Agent prompt. */
		function assistSummaryKey(code, variant) {
			switch (code) {
				case "electron-binary-not-found": return "assistNotFound";
				case "electron-binary-ambiguous": return "assistAmbiguous";
				case "electron-discovery-incomplete": return "assistIncomplete";
				case "electron-path-invalid": return "assistPathInvalid";
				default: return variant.unavailableKey;
			}
		}
		/** Copy text to the clipboard, reporting whether it worked. */
		async function copyPrompt(text) {
			try {
				if (navigator.clipboard?.writeText === void 0) return false;
				await navigator.clipboard.writeText(text);
				return true;
			} catch {
				return false;
			}
		}
		/**
		* The Agent assist block for a path failure: what is wrong, one copyable
		* request, and a re-check. Rendered only for the codes above.
		*/
		function AssistBlock({ t, variant, failureSummary, busy, onRecheck }) {
			const [copied, setCopied] = (0, react.useState)(false);
			const [copyFailed, setCopyFailed] = (0, react.useState)(false);
			const prompt = t("assistantPrompt", {
				appName: variant.appName,
				failureSummary
			});
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: assistStyle,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h4", {
						style: assistHeadingStyle,
						children: t("assistantHeading")
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						style: bodyStyle$1,
						children: t("assistantIntro")
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: assistPromptRowStyle,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							style: assistPromptStyle,
							children: prompt
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							style: buttonStyle$2,
							onClick: () => {
								(async () => {
									const ok = await copyPrompt(prompt);
									setCopied(ok);
									setCopyFailed(!ok);
								})();
							},
							children: t("assistantCopy")
						})]
					}),
					copied ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						style: assistFeedbackStyle,
						role: "status",
						children: t("assistantCopied")
					}) : null,
					copyFailed ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						style: assistFeedbackStyle,
						role: "status",
						children: t("assistantCopyFailed")
					}) : null,
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						style: bodyStyle$1,
						children: t("assistantAfter")
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: rowStyle$1,
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							style: buttonStyle$2,
							disabled: busy,
							onClick: onRecheck,
							children: busy ? t("assistantRechecking") : t("assistantRecheck")
						})
					})
				]
			});
		}
		const cardStyle = {
			overflow: "hidden",
			border: "1px solid var(--dsw-alias-border-l2)",
			borderRadius: 10,
			background: "var(--dsw-alias-bg-module-platform)",
			listStyle: "none"
		};
		const headerStyle = {
			boxSizing: "border-box",
			width: "100%",
			display: "flex",
			alignItems: "center",
			justifyContent: "space-between",
			gap: 16,
			border: 0,
			padding: "13px 14px",
			background: "transparent",
			color: "var(--dsw-alias-label-primary)",
			font: "inherit",
			textAlign: "left",
			cursor: "pointer"
		};
		const headTextStyle = {
			display: "flex",
			minWidth: 0,
			flexDirection: "column",
			gap: 3
		};
		const nameStyle = {
			fontSize: 14,
			lineHeight: "20px",
			fontWeight: 600
		};
		const descriptionStyle = {
			fontSize: 13,
			lineHeight: "18px",
			color: "var(--dsw-alias-label-tertiary)"
		};
		const chevronStyle = {
			flex: "0 0 auto",
			fontSize: 18,
			lineHeight: 1,
			transition: "transform 120ms ease"
		};
		const cardBodyStyle = {
			borderTop: "1px solid var(--dsw-alias-border-l2)",
			padding: "16px 14px 18px"
		};
		const bodyStyle$1 = {
			margin: 0,
			fontSize: 14,
			lineHeight: "22px",
			color: "var(--dsw-alias-label-secondary)"
		};
		const rowStyle$1 = {
			display: "flex",
			alignItems: "center",
			justifyContent: "space-between",
			flexWrap: "wrap",
			gap: 12
		};
		const statusStyle = {
			display: "flex",
			alignItems: "center",
			gap: 9,
			fontSize: 15,
			fontWeight: 500,
			color: "var(--dsw-alias-label-primary)"
		};
		const buttonStyle$2 = {
			boxSizing: "border-box",
			minHeight: 34,
			padding: "6px 14px",
			border: "1px solid var(--dsw-alias-border-l2)",
			borderRadius: 18,
			background: "var(--dsw-alias-bg-layer-1)",
			color: "var(--dsw-alias-label-primary)",
			font: "inherit",
			fontSize: 14,
			cursor: "pointer"
		};
		const errorStyle = {
			...bodyStyle$1,
			color: "var(--dsw-alias-state-error-primary)"
		};
		const noticeStyle = {
			display: "flex",
			flexDirection: "column",
			gap: 2,
			padding: "10px 12px",
			borderRadius: 8,
			border: "1px solid",
			fontSize: 13,
			lineHeight: "18px"
		};
		const noticeDetailStyle = {
			fontSize: 12,
			lineHeight: "16px",
			opacity: .8
		};
		const urgentNoticeStyle = {
			background: "var(--dsw-alias-state-warn-tertiary, #fff4e5)",
			borderColor: "var(--dsw-alias-state-warn-primary, #d97706)",
			color: "var(--dsw-alias-label-primary)"
		};
		const warnNoticeStyle = {
			background: "var(--dsw-alias-bg-l2, #f6f7f9)",
			borderColor: "var(--dsw-alias-border-l2)",
			color: "var(--dsw-alias-label-primary)"
		};
		const expiredNoticeStyle = {
			background: "var(--dsw-alias-bg-l2, #f6f7f9)",
			borderColor: "var(--dsw-alias-border-l2)",
			color: "var(--dsw-alias-label-tertiary)"
		};
		const quotaListStyle = {
			display: "flex",
			flexDirection: "column",
			gap: 18,
			paddingTop: 2
		};
		const quotaGroupStyle = {
			display: "flex",
			flexDirection: "column",
			gap: 10
		};
		const quotaTitleStyle = {
			margin: 0,
			fontSize: 14,
			lineHeight: "20px",
			fontWeight: 600,
			color: "var(--dsw-alias-label-primary)"
		};
		const quotaLabelStyle = {
			display: "flex",
			justifyContent: "space-between",
			gap: 12,
			fontSize: 13,
			lineHeight: "20px",
			color: "var(--dsw-alias-label-secondary)"
		};
		const modelBadgeStyle = {
			display: "flex",
			alignItems: "center",
			gap: 6,
			flexWrap: "wrap"
		};
		const modelOfferStyle = {
			display: "flex",
			flexDirection: "column",
			gap: 2
		};
		const modelRateStyle = {
			fontSize: 12,
			lineHeight: "18px",
			color: "var(--dsw-alias-label-tertiary)"
		};
		const contextPreferenceStyle = {
			display: "flex",
			alignItems: "flex-start",
			gap: 9,
			padding: "10px 12px",
			border: "1px solid var(--dsw-alias-border-l2)",
			borderRadius: 8,
			color: "var(--dsw-alias-label-primary)",
			fontSize: 13,
			lineHeight: "20px"
		};
		const contextPreferenceCopyStyle = {
			display: "flex",
			flexDirection: "column",
			gap: 2
		};
		/**
		* The Agent assist block. Sits beside the existing error line rather than
		* replacing it: the short diagnosis stays the headline, this adds the way out.
		*/
		const assistStyle = {
			display: "flex",
			flexDirection: "column",
			gap: 10,
			padding: "12px 14px",
			marginTop: 12,
			border: "1px solid var(--dsw-alias-border-l2)",
			borderRadius: 10,
			background: "var(--dsw-alias-bg-layer-2, rgba(0, 0, 0, 0.04))"
		};
		const assistHeadingStyle = {
			margin: 0,
			fontSize: 14,
			lineHeight: "20px",
			fontWeight: 600,
			color: "var(--dsw-alias-label-primary)"
		};
		const assistPromptRowStyle = {
			display: "flex",
			flexWrap: "wrap",
			alignItems: "flex-start",
			gap: 8,
			padding: "8px 9px 8px 11px",
			borderRadius: 7,
			background: "var(--dsw-alias-bg-layer-1)"
		};
		const assistPromptStyle = {
			flex: "1 1 220px",
			minWidth: 0,
			margin: 0,
			color: "var(--dsw-alias-label-primary)",
			fontSize: 12,
			lineHeight: "19px",
			whiteSpace: "pre-wrap",
			overflowWrap: "anywhere",
			userSelect: "text"
		};
		const assistFeedbackStyle = {
			margin: 0,
			fontSize: 12,
			lineHeight: "19px",
			color: "var(--dsw-alias-label-secondary)"
		};
		/**
		* Left half of one merged context/visibility row: the visibility checkbox (when
		* the account has one) beside the model's name and rate. Kept as a flex span so
		* the capacity column stays flush right no matter how long the name runs.
		*/
		const contextRowMainStyle = {
			display: "flex",
			alignItems: "center",
			gap: 9,
			minWidth: 0
		};
		const modelBadgeChipStyle = {
			padding: "1px 8px",
			borderRadius: 999,
			fontSize: 11,
			lineHeight: "18px",
			background: "var(--dsw-alias-state-success-subtle, rgba(34, 160, 107, 0.12))",
			color: "var(--dsw-alias-state-success-primary, #22a06b)"
		};
		/**
		* Localize an upstream promotional badge label, with an unknown-badge fallback.
		*
		* The CN catalog spells badges in Chinese (`限时免费`, `夜间折扣`); the
		* international document's `modelPromotions` carries English (`Free now`). Both
		* are mapped so the same promotion reads consistently in either UI language,
		* and anything else passes through verbatim — an unrecognized badge is still
		* information the upstream chose to show.
		*/
		function modelBadgeLabel(badge, t) {
			if (badge === "限时免费") return t("badgeLimitedFree");
			if (badge === "夜间折扣") return t("badgeNightDiscount");
			if (badge === "Free now") return t("badgeFreeNow");
			return badge;
		}
		const progressTrackStyle = {
			height: 8,
			overflow: "hidden",
			borderRadius: 999,
			background: "var(--dsw-alias-bg-layer-2, rgba(0, 0, 0, 0.08))"
		};
		/**
		* Inline confirmation box for a paid detection. Replaces the previous
		* `window.confirm`: the decision is one line plus two buttons, and a modal
		* alert for that is heavier than the action it guards.
		*/
		const confirmBoxStyle = {
			display: "flex",
			flexDirection: "column",
			gap: 10,
			padding: "10px 12px",
			border: "1px solid var(--dsw-alias-border-l2)",
			borderRadius: 8,
			background: "var(--dsw-alias-bg-layer-1)"
		};
		const confirmRowStyle$1 = {
			display: "flex",
			justifyContent: "flex-end",
			gap: 8
		};
		/** One probeable model's row: name on the left, state and action on the right. */
		const probeRowStyle = {
			display: "flex",
			alignItems: "center",
			justifyContent: "space-between",
			gap: 12
		};
		const probeRowEndStyle = {
			display: "inline-flex",
			alignItems: "center",
			gap: 8,
			flex: "0 0 auto"
		};
		/**
		* Tab strip for the card body. Kept visually light — a full pill would compete
		* with the section headings, and the card is already the densest surface the
		* plugin owns.
		*/
		const tabBarStyle = {
			display: "flex",
			gap: 4,
			marginTop: 4,
			borderBottom: "1px solid var(--dsw-alias-border-l2)"
		};
		const tabStyle = {
			padding: "6px 12px",
			border: 0,
			borderBottom: "2px solid transparent",
			background: "transparent",
			color: "var(--dsw-alias-label-tertiary)",
			font: "inherit",
			fontSize: 13,
			lineHeight: "20px",
			cursor: "pointer"
		};
		const tabActiveStyle = {
			borderBottom: "2px solid var(--dsw-alias-brand-primary)",
			color: "var(--dsw-alias-label-primary)",
			fontWeight: 600
		};
		const tabPanelStyle = {
			display: "flex",
			flexDirection: "column",
			gap: 18,
			paddingTop: 16
		};
		/**
		* Primary action of the inline confirmation. Fill and text colour come from the
		* theme as a pair: `brand-primary` is a light accent here, so pairing it with a
		* hardcoded white would render white-on-white.
		*/
		const primaryButtonStyle$2 = {
			...buttonStyle$2,
			border: "1px solid var(--dsw-alias-button-primary-fill)",
			background: "var(--dsw-alias-button-primary-fill)",
			color: "var(--dsw-alias-label-primary-foreground)"
		};
		function progressFillStyle(percent) {
			return {
				width: `${Math.max(0, Math.min(100, percent))}%`,
				height: "100%",
				borderRadius: "inherit",
				background: "var(--dsw-alias-brand-primary, #1677ff)"
			};
		}
		/**
		* Status dot colour. Takes `'loading'` as well as the document's own states:
		* before the first response the card knows nothing about the account, so it must
		* not borrow the signed-out grey — that would read as "nothing is wrong, nobody
		* is signed in" when the truth is "not read yet".
		*/
		function dotStyle(status) {
			return {
				width: 9,
				height: 9,
				borderRadius: "50%",
				flex: "0 0 auto",
				background: status === "signed-in" ? "var(--dsw-alias-state-success-primary, #22a06b)" : status === "error" ? "var(--dsw-alias-state-error-primary, #d92d20)" : "var(--dsw-alias-label-dimmed, #9aa0a6)"
			};
		}
		function formatNumber(value) {
			return new Intl.NumberFormat(void 0).format(value);
		}
		function formatTime(ms) {
			return new Intl.DateTimeFormat(void 0, {
				dateStyle: "medium",
				timeStyle: "short"
			}).format(new Date(ms));
		}
		function formatCycleReset(time) {
			const parsed = Date.parse(time);
			if (!Number.isNaN(parsed)) return formatTime(parsed);
			return time;
		}
		/**
		* A warning that credit is about to lapse.
		*
		* The total alone cannot express this: a package expiring in an hour and one
		* expiring next month both render as "500 credit", so a user watching only the
		* total loses the first one silently. The banner names the amount, the package
		* count and the soonest expiry, and escalates 7d → 24h → already-lapsed.
		*
		* Renders nothing when the upstream reported no end times at all — absence of
		* expiry data is not evidence that nothing expires, so the component stays
		* silent rather than reassuring.
		*/
		function ExpiryNotice({ expiry, t }) {
			const { expired, within24h, within7d } = expiry;
			let message;
			let soonest;
			let tone;
			if (within24h.packages > 0) {
				message = t("expiryWarningSoon", {
					total: formatNumber(Math.round(within24h.total * 100) / 100),
					packages: String(within24h.packages)
				});
				soonest = within24h.earliestEndTimeMs;
				tone = urgentNoticeStyle;
			} else if (within7d.packages > 0) {
				message = t("expiryWarningWeek", {
					total: formatNumber(Math.round(within7d.total * 100) / 100),
					packages: String(within7d.packages)
				});
				soonest = within7d.earliestEndTimeMs;
				tone = warnNoticeStyle;
			} else if (expired.packages > 0) {
				message = t("expiryWarningExpired", {
					total: formatNumber(Math.round(expired.total * 100) / 100),
					packages: String(expired.packages)
				});
				tone = expiredNoticeStyle;
			} else return null;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: {
					...noticeStyle,
					...tone
				},
				role: "status",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: message }), soonest === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					style: noticeDetailStyle,
					children: t("expiryExpiresAt", { time: formatTime(soonest) })
				})]
			});
		}
		/**
		* One billing package as a labeled progress bar.
		*
		* A package whose allowance the upstream never reported (`size` not positive)
		* has no percentage to state. It must not fall back to 100%: the plugin would be
		* claiming a full quota it knows nothing about, which is the opposite of the
		* honest "remaining N" line printed below it. Unknown size therefore renders the
		* percent slot as unknown copy and an unfilled, indeterminate track.
		*/
		function CreditBar({ label, remain, size, unlimited, t }) {
			if (unlimited === true) {
				const quotaText = t("unlimitedQuota");
				return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					style: quotaGroupStyle,
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: quotaLabelStyle,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: label }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: quotaText })]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							style: progressTrackStyle,
							role: "progressbar",
							"aria-label": label,
							"aria-valuetext": quotaText
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							style: bodyStyle$1,
							children: quotaText
						})
					]
				});
			}
			const sizeKnown = size > 0;
			const detail = sizeKnown ? t("exactRemaining", {
				remain: formatNumber(remain),
				size: formatNumber(size)
			}) : t("creditPackageUnknownSize", { remain: formatNumber(remain) });
			const percent = sizeKnown ? remain / size * 100 : void 0;
			const display = percent === void 0 ? t("percentUnknown") : t("percentRemaining", { percent: new Intl.NumberFormat(void 0, { maximumFractionDigits: 1 }).format(percent) });
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: quotaGroupStyle,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: quotaLabelStyle,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: label }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: display })]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: progressTrackStyle,
						role: "progressbar",
						"aria-label": label,
						...percent === void 0 ? { "aria-valuetext": detail } : {
							"aria-valuemin": 0,
							"aria-valuemax": 100,
							"aria-valuenow": percent
						},
						children: percent === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", { style: progressFillStyle(percent) })
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						style: bodyStyle$1,
						children: detail
					})
				]
			});
		}
		/**
		* One model offer row: name, promotional badges, and the billing rate.
		*
		* The rate sits under the name rather than beside it because the row already
		* spends its horizontal budget on badges; stacking keeps long model names and
		* several badges from squeezing the rate into an ellipsis.
		*/
		function ModelOfferRow({ model, t }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: modelOfferStyle,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					style: quotaLabelStyle,
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: model.name }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
						style: modelBadgeStyle,
						children: [model.badges?.map((badge) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: modelBadgeChipStyle,
							children: modelBadgeLabel(badge, t)
						}, badge)), model.free === true ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: modelBadgeChipStyle,
							children: t("freeModel")
						}) : null]
					})]
				}), model.credits === void 0 ? model.rateUnknown === true ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					style: modelRateStyle,
					children: t("rateUnknown")
				}) : null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					style: modelRateStyle,
					children: t("rate", { rate: model.credits })
				})]
			});
		}
		/**
		* Context window and model visibility, one row per catalog model.
		*
		* The list is driven by the full current catalog, not by context metadata:
		* hiding a model is a statement about the picker, and a model without a
		* declared window is still hideable — its row just shows an em dash where the
		* capacity would be. Rows with a window keep the original ordering (largest
		* first); rows without one trail at the end in catalog order.
		*
		* Each row is one <label>, so the checkbox is named by its row without a
		* duplicated aria string. The checkbox state comes from the status document
		* only — no optimistic flip — so a save that fails leaves the box where the
		* host's truth says it is, next to the failure notice `control` records.
		* Checkboxes render only when the document carries a visibility section (a
		* signed-in account with a stable user id); a uid-less credential shows the
		* plain capacity list rather than editing a bucket every such account would
		* share.
		*
		* Purely a report of the upstream's own numbers otherwise. The plugin offers
		* no tier picker: the CN catalog declares one capacity per model and publishes
		* no alternatives, so a menu there would mean inventing client-side policy.
		* The international document does declare alternatives (`supportedLengths`),
		* and they are shown as a secondary figure rather than merged into one number —
		* the default is the budget actually requested, while the larger value is a
		* ceiling the upstream would accept.
		*/
		function ContextTable({ models, t, useMaximumContextWindow, contextPreferenceDisabled, onUseMaximumContextWindow, visibility, visibilityControlsDisabled, visibilityToggling, onVisibilityToggle }) {
			const rows = [...models ?? []].sort((a, b) => {
				if (a.contextWindow === void 0) return b.contextWindow === void 0 ? 0 : 1;
				if (b.contextWindow === void 0) return -1;
				return b.contextWindow - a.contextWindow;
			});
			const canSelectMaximum = rows.some((model) => model.maxContextWindow !== void 0 && model.maxContextWindow > (model.defaultContextWindow ?? model.contextWindow ?? 0));
			const showPreference = onUseMaximumContextWindow !== void 0 && (canSelectMaximum || useMaximumContextWindow === true);
			if (rows.length === 0 && !showPreference) return null;
			const hidden = new Set(visibility?.disabled ?? []);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: quotaListStyle,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", {
						style: quotaTitleStyle,
						children: t("contextHeading")
					}),
					showPreference && onUseMaximumContextWindow !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
						style: contextPreferenceStyle,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
							type: "checkbox",
							checked: useMaximumContextWindow === true,
							disabled: contextPreferenceDisabled,
							onChange: (event) => {
								onUseMaximumContextWindow(event.currentTarget.checked);
							}
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							style: contextPreferenceCopyStyle,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("useMaximumContextWindow") }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: modelRateStyle,
								children: t("useMaximumContextWindowHint")
							})]
						})]
					}) : null,
					visibility === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						style: bodyStyle$1,
						children: t("visibilityIntro")
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: quotaGroupStyle,
						children: rows.map((model) => {
							const capacity = model.contextWindow;
							const alternative = capacity !== void 0 && model.maxContextWindow !== void 0 && model.maxContextWindow > capacity ? model.maxContextWindow : void 0;
							return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
								style: quotaLabelStyle,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									style: contextRowMainStyle,
									children: [visibility === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
										type: "checkbox",
										checked: !hidden.has(model.id),
										disabled: visibilityControlsDisabled || visibilityToggling.has(model.id),
										onChange: (event) => {
											onVisibilityToggle?.(model.id, event.currentTarget.checked);
										}
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
										style: modelOfferStyle,
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
											style: modelBadgeStyle,
											children: [
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: model.name }),
												model.badges?.map((badge) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
													style: modelBadgeChipStyle,
													children: modelBadgeLabel(badge, t)
												}, badge)),
												model.free === true ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
													style: modelBadgeChipStyle,
													children: t("freeModel")
												}) : null
											]
										}), model.credits === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											style: modelRateStyle,
											children: model.credits
										})]
									})]
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									style: modelOfferStyle,
									children: [capacity === void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										style: modelRateStyle,
										"aria-label": t("contextUnknown"),
										children: "—"
									}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										style: { textAlign: "right" },
										children: formatTokens(capacity)
									}), alternative !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										style: modelRateStyle,
										children: t("contextUpTo", { size: formatTokens(alternative) })
									}) : capacity !== void 0 && model.defaultContextWindow !== void 0 && model.defaultContextWindow < capacity ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										style: modelRateStyle,
										children: t("contextDefault", { size: formatTokens(model.defaultContextWindow) })
									}) : null]
								})]
							}, model.id);
						})
					})
				]
			});
		}
		/**
		* Compact token count for display: the catalog's own round numbers (`200000`,
		* `1000000`) read better as `200K` / `1M`, and no precision is lost because
		* these values are always whole thousands.
		*/
		function formatTokens(tokens) {
			if (tokens >= 1e6 && tokens % 1e6 === 0) return `${tokens / 1e6}M`;
			if (tokens >= 1e3 && tokens % 1e3 === 0) return `${tokens / 1e3}K`;
			return String(tokens);
		}
		/**
		* Reasoning-effort detection section: consent switches, per-model detection,
		* and the recorded observations.
		*
		* Two deliberate UX rules from the plan (§3.1, §3.2):
		* - the confirmation is shown *before* any request, and its copy states the
		*   credit caveat;
		* - a `non-validating` result is presented as an observation about the
		*   parameter ("this model does not check it"), never as a statement that a
		*   level is unsupported.
		*/
		function ProbeSection({ probe, models, t, onDetect, onClear, busy }) {
			const [pending, setPending] = (0, react.useState)();
			const [runningModel, setRunningModel] = (0, react.useState)();
			(0, react.useEffect)(() => {
				if (pending !== void 0 && !probe.candidates.includes(pending)) setPending(void 0);
			}, [pending, probe.candidates]);
			const runningArmed = (0, react.useRef)(false);
			(0, react.useEffect)(() => {
				if (runningModel === void 0) return;
				if (busy || probe.running) {
					runningArmed.current = true;
					return;
				}
				if (!runningArmed.current) return;
				runningArmed.current = false;
				setRunningModel(void 0);
			}, [
				runningModel,
				busy,
				probe.running
			]);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: quotaListStyle,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", {
						style: quotaTitleStyle,
						children: t("probeHeading")
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						style: bodyStyle$1,
						children: t("probeIntro")
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						style: bodyStyle$1,
						children: t("probeConsentHint")
					}),
					probe.running ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						style: bodyStyle$1,
						children: t("probeRunningGeneric")
					}) : null,
					probe.candidates.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						style: bodyStyle$1,
						children: t("probeResultEmpty")
					}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: quotaGroupStyle,
						children: probe.candidates.map((id) => {
							const result = probe.results.find((entry) => entry.id === id);
							const name = models?.find((model) => model.id === id)?.name ?? result?.name ?? id;
							return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: modelOfferStyle,
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										style: probeRowStyle,
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: name }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
											style: probeRowEndStyle,
											children: [result === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												style: modelBadgeChipStyle,
												children: result.validation === "validating" && result.efforts.length > 0 ? result.efforts.join(" / ") : t(result.validation === "non-validating" ? "probeResultNotValidating" : "probeResultUnknown")
											}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
												type: "button",
												style: buttonStyle$2,
												disabled: probe.running || busy,
												onClick: () => {
													setPending(id);
												},
												children: runningModel === id ? t("probeRunning", { model: name }) : t(result === void 0 ? "probeStart" : "probeRedetect")
											})]
										})]
									}),
									result === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										style: modelRateStyle,
										children: t("probeResultAt", { time: formatTime(result.probedAt) })
									}),
									pending === id ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										style: confirmBoxStyle,
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
											style: bodyStyle$1,
											children: t("probeConfirmBody", { model: name })
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
											style: confirmRowStyle$1,
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
												type: "button",
												style: buttonStyle$2,
												onClick: () => {
													setPending(void 0);
												},
												children: t("cancel")
											}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
												type: "button",
												style: primaryButtonStyle$2,
												disabled: probe.running || busy,
												onClick: () => {
													setRunningModel(id);
													setPending(void 0);
													onDetect(id);
												},
												children: t("probeConfirmAction")
											})]
										})]
									}) : null
								]
							}, id);
						})
					}),
					probe.results.length === 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						style: buttonStyle$2,
						disabled: busy,
						onClick: () => {
							onClear();
						},
						children: t("probeClear")
					})
				]
			});
		}
		/** Render WorkBuddy sign-in state and credit as one expandable card. */
		function WorkBuddyPluginCard({ t, variant = CN_CARD_VARIANT }) {
			if (t === void 0) throw new Error("WorkBuddy plugin card requires its translation function");
			const [open, setOpen] = (0, react.useState)(false);
			/**
			* The document to render. `undefined` means *not read yet*, which is a
			* distinct state from "signed out": seeding this with a signed-out document
			* told an already-signed-in user they were signed out for the whole first
			* round trip (and forever, if the read never settled).
			*/
			const [status, setStatus] = (0, react.useState)();
			/**
			* Whether the last **successful** read found a usable credential.
			*
			* Kept apart from `status` because the poll's liveness must depend on what the
			* account actually is, not on what the card last displayed: a failed read
			* leaves this untouched, so a transient failure cannot disarm the interval,
			* while a genuine signed-out answer still stops it.
			*
			* `undefined` therefore means "no successful read yet", which is also the
			* condition that decides whether a failed read has anything to preserve.
			*/
			const [signedIn, setSignedIn] = (0, react.useState)();
			/**
			* Why the most recent read failed, when it did. Rendered as a notice beside
			* whatever document is still on screen, rather than replacing it.
			*/
			const [readFailure, setReadFailure] = (0, react.useState)();
			const [busy, setBusy] = (0, react.useState)(false);
			/**
			* The model ids whose visibility writes are in flight, empty when none are.
			* Deliberately NOT the card-wide `busy` (that flag drives the Refresh
			* buttons' labels, which must not claim a refresh the user never pressed)
			* and deliberately per-row rather than whole-list: a visibility write only
			* adds or removes one model's id, so the rows are independent — locking
			* every checkbox for one row's write made the whole list visibly blink for
			* no correctness gain. A set, because two writes can be open at once when
			* the user moves down the list; only the rows being written lock.
			*/
			const [togglingModels, setTogglingModels] = (0, react.useState)(() => /* @__PURE__ */ new Set());
			const [tab, setTab] = (0, react.useState)("status");
			const mounted = (0, react.useRef)(true);
			/**
			* Identity of the newest read that may write. Assigned when a read *starts*,
			* so a response is superseded by anything begun after it — "the response whose
			* request started last wins". Without this, a slow poll begun before a manual
			* action could settle after the action's own refresh and restore the older
			* document.
			*/
			const readSeq = (0, react.useRef)(0);
			/** Manual requests in flight, so unmount can abort them like the poll's. */
			const manualControllers = (0, react.useRef)(/* @__PURE__ */ new Set());
			(0, react.useEffect)(() => {
				mounted.current = true;
				return () => {
					mounted.current = false;
					for (const controller of manualControllers.current) controller.abort();
					manualControllers.current.clear();
				};
			}, []);
			/** Register a manual request's controller so unmount aborts it. */
			const trackController = (0, react.useCallback)(() => {
				const controller = new AbortController();
				manualControllers.current.add(controller);
				return controller;
			}, []);
			/**
			* Read the status document and apply it under the two policies the card's
			* correctness rests on:
			*
			* - a non-document body (empty, `null`, a non-JSON page) is a failed read, not
			*   something to store and then dereference in the render;
			* - a failed read never discards a document already on screen. It is recorded
			*   and shown as a notice beside that document; only when nothing has been
			*   read yet does the failure itself become the rendered state.
			*
			* Returns whether this read produced the current document.
			*/
			const refresh = (0, react.useCallback)(async (signal) => {
				const seq = ++readSeq.current;
				const current = () => mounted.current && signal?.aborted !== true && seq === readSeq.current;
				try {
					const response = await fetch(variant.statusPath, {
						headers: { accept: "application/json" },
						credentials: "same-origin",
						...signal === void 0 ? {} : { signal }
					});
					const value = await response.json().catch(() => void 0);
					if (!response.ok) throw new Error(`HTTP ${response.status}`);
					if (!isWorkBuddyWebStatus(value)) throw new Error(t("statusResponseInvalid"));
					if (!current()) return false;
					setStatus(value);
					if (value.status === "signed-in") setSignedIn(true);
					else if (value.status === "signed-out") setSignedIn(false);
					setReadFailure(void 0);
					return true;
				} catch (error) {
					const message = error instanceof Error ? error.message : t("requestFailed");
					if (current()) {
						setReadFailure(message);
						setStatus((previous) => previous === void 0 ? {
							status: "error",
							message
						} : previous);
					}
					return false;
				}
			}, [t, variant.statusPath]);
			(0, react.useEffect)(() => {
				if (!open) return;
				const controller = new AbortController();
				refresh(controller.signal);
				return () => {
					controller.abort();
				};
			}, [open, refresh]);
			(0, react.useEffect)(() => {
				if (!open || signedIn === false) return;
				const controller = new AbortController();
				const timer = window.setInterval(() => {
					refresh(controller.signal);
				}, POLL_INTERVAL_MS);
				return () => {
					window.clearInterval(timer);
					controller.abort();
				};
			}, [
				open,
				refresh,
				signedIn
			]);
			const manualRefresh = async () => {
				setBusy(true);
				const controller = trackController();
				try {
					await refresh(controller.signal);
				} finally {
					manualControllers.current.delete(controller);
					if (mounted.current) setBusy(false);
				}
			};
			/**
			* Ask the host to re-read the credential and re-fetch this variant's catalog.
			*
			* Shares the probe route's key and guards: it is a write that spends an
			* upstream request, so it does not belong on the read-only status GET. A
			* failure is surfaced through the refreshed document's `catalog.error` rather
			* than thrown away, so the reason survives the round trip.
			*/
			const refreshModels = (0, react.useCallback)(async () => {
				const key = status?.status === "signed-in" ? status.probeKey : void 0;
				if (key === void 0) return;
				setBusy(true);
				const controller = trackController();
				try {
					const response = await fetch(variant.probePath, {
						method: "POST",
						headers: {
							"Content-Type": "application/json",
							"X-WorkBuddy-Probe-Key": key
						},
						credentials: "same-origin",
						signal: controller.signal,
						body: JSON.stringify({ action: "refresh" })
					});
					if (!response.ok) throw new Error(`HTTP ${response.status}`);
				} catch (error) {
					if (mounted.current && controller.signal.aborted !== true) setReadFailure(error instanceof Error ? error.message : t("requestFailed"));
					manualControllers.current.delete(controller);
					return;
				} finally {
					if (mounted.current) setBusy(false);
				}
				try {
					await refresh(controller.signal);
				} finally {
					manualControllers.current.delete(controller);
				}
			}, [
				refresh,
				status,
				t,
				trackController,
				variant.probePath
			]);
			/**
			* Run one control action and refresh the card's state afterwards.
			*
			* The key travels in a header, not the body: it authorizes the write, and
			* the host never accepts a prompt, a sentinel, or a model outside its own
			* catalog from here.
			*/
			const control = (0, react.useCallback)(async (action) => {
				const key = status?.status === "signed-in" ? status.probeKey : void 0;
				if (key === void 0) return;
				const visibility = action.action === "set-model-visibility";
				if (visibility) setTogglingModels((previous) => new Set(previous).add(action.model));
				else setBusy(true);
				const controller = trackController();
				try {
					const response = await fetch(variant.probePath, {
						method: "POST",
						headers: {
							"Content-Type": "application/json",
							"X-Workbuddy-Probe-Key": key
						},
						credentials: "same-origin",
						signal: controller.signal,
						body: JSON.stringify(action)
					});
					const value = await response.json().catch(() => void 0);
					if (!response.ok) {
						const message = typeof value === "object" && value !== null && "error" in value ? String(value["error"]) : `HTTP ${response.status}`;
						throw new Error(message);
					}
					if ((action.action === "set-maximum-context-window" || action.action === "set-model-visibility") && (typeof value !== "object" || value === null || value["state"] !== "updated")) {
						const state = typeof value === "object" && value !== null ? value["state"] : void 0;
						if (action.action === "set-model-visibility" && state === "stale-account") {
							await refresh(controller.signal);
							throw new Error(t("visibilityStaleAccount"));
						}
						const reason = typeof value === "object" && value !== null && "reason" in value ? String(value["reason"]) : t("requestFailed");
						throw new Error(reason);
					}
					await refresh(controller.signal);
				} catch (error) {
					if (mounted.current && controller.signal.aborted !== true) setReadFailure(error instanceof Error ? error.message : t("requestFailed"));
				} finally {
					manualControllers.current.delete(controller);
					if (!mounted.current) return;
					if (visibility) setTogglingModels((previous) => {
						const next = new Set(previous);
						next.delete(action.model);
						return next;
					});
					else setBusy(false);
				}
			}, [
				refresh,
				status,
				t,
				trackController,
				variant.probePath
			]);
			/**
			* Start a detection. Confirmation happens inline in the section, so this is
			* only ever called after the user has already agreed.
			*/
			const confirmDetect = (0, react.useCallback)((modelId) => {
				control({
					action: "probe",
					model: modelId
				});
			}, [control]);
			const title = t(variant.titleKey);
			/**
			* The failure the assist block covers, when this document has one. Computed
			* once so the block and the header's refresh button agree on whether the
			* block owns the re-check action — showing both would put two buttons with
			* the same effect side by side.
			*/
			const assistCode = status?.status === "signed-out" && isWorkBuddySignedOutReasonCode(status.reasonCode) && ASSIST_REASON_CODES.includes(status.reasonCode) ? status.reasonCode : void 0;
			const label = status === void 0 ? t("loading") : status.status === "signed-in" ? status.nickname === void 0 ? t("signedInAs", { nickname: "" }).trimEnd().replace(/[:：]$/, "") : t("signedInAs", { nickname: status.nickname }) : status.status === "error" ? t("requestFailed") : t("signedOut");
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", {
				style: cardStyle,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
					type: "button",
					style: headerStyle,
					"aria-expanded": open,
					"aria-label": `${t(open ? "collapse" : "expand")}: ${title}`,
					onClick: () => {
						setOpen(!open);
					},
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
						style: headTextStyle,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: nameStyle,
							children: title
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: descriptionStyle,
							children: t(variant.introKey)
						})]
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						"aria-hidden": "true",
						style: {
							...chevronStyle,
							transform: open ? "rotate(180deg)" : "none"
						},
						children: "⌄"
					})]
				}), open ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					style: cardBodyStyle,
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", {
							style: quotaTitleStyle,
							children: t("accountHeading")
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: rowStyle$1,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: statusStyle,
								role: "status",
								"aria-busy": status === void 0,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									"aria-hidden": "true",
									style: dotStyle(status === void 0 ? "loading" : status.status)
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: label })]
							}), assistCode === void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								style: buttonStyle$2,
								disabled: busy,
								onClick: () => {
									manualRefresh();
								},
								children: busy ? t("refreshing") : t("refresh")
							}) : null]
						}),
						readFailure === void 0 || signedIn === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							style: errorStyle,
							children: t("statusRefreshFailed", { message: readFailure })
						}),
						status?.status === "signed-in" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
							status.expiresAt === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								style: bodyStyle$1,
								children: t("accessTokenExpires", { time: formatTime(status.expiresAt) })
							}),
							status.catalog === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: rowStyle$1,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									style: bodyStyle$1,
									children: [status.catalog.source === "live" && status.catalog.fetchedAt !== void 0 ? t("catalogLive", { time: formatTime(status.catalog.fetchedAt) }) : status.catalog.source === "saved" && status.catalog.fetchedAt !== void 0 ? t("catalogSaved", { time: formatTime(status.catalog.fetchedAt) }) : t("catalogFallback"), status.catalog.appVersion === void 0 ? "" : ` · ${t("catalogAppVersion", { version: status.catalog.appVersion })}`]
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									style: buttonStyle$2,
									disabled: busy,
									onClick: () => {
										refreshModels();
									},
									children: busy ? t("refreshingModels") : t("refreshModels")
								})]
							}),
							status.catalog?.error === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								style: errorStyle,
								children: t("catalogError", { message: status.catalog.error })
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								role: "tablist",
								style: tabBarStyle,
								children: [
									"status",
									"context",
									"details"
								].map((id) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									role: "tab",
									"aria-selected": tab === id,
									onClick: () => {
										setTab(id);
									},
									style: {
										...tabStyle,
										...tab === id ? tabActiveStyle : {}
									},
									children: t(id === "status" ? "tabStatus" : id === "context" ? "tabContext" : "tabDetails")
								}, id))
							}),
							tab === "status" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: tabPanelStyle,
								children: [
									status.credits === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										style: quotaListStyle,
										children: [
											status.credits.expiry === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ExpiryNotice, {
												expiry: status.credits.expiry,
												t
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
												style: rowStyle$1,
												children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", {
													style: quotaTitleStyle,
													children: t("creditsHeading")
												}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
													style: bodyStyle$1,
													children: status.credits.unlimited === true ? t("creditsTotalUnlimited") : t("creditsTotal", { total: formatNumber(status.credits.total) })
												})]
											}),
											status.credits.cycleResetTime === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
												style: descriptionStyle,
												children: t("cycleResetAt", { time: formatCycleReset(status.credits.cycleResetTime) })
											})
										]
									}),
									status.creditsError === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
										style: errorStyle,
										children: t("creditsError", { message: status.creditsError })
									}),
									status.probe === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ProbeSection, {
										probe: status.probe,
										models: status.models,
										t,
										busy,
										onDetect: confirmDetect,
										onClear: () => {
											control({ action: "clear" });
										}
									})
								]
							}) : tab === "context" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								style: tabPanelStyle,
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ContextTable, {
									models: status.models,
									t,
									contextPreferenceDisabled: busy,
									...variant.id === AI_CARD_VARIANT.id && status.useMaximumContextWindow !== void 0 ? {
										useMaximumContextWindow: status.useMaximumContextWindow,
										onUseMaximumContextWindow: (enabled) => {
											control({
												action: "set-maximum-context-window",
												enabled
											});
										}
									} : {},
									visibility: status.visibility,
									visibilityControlsDisabled: busy,
									visibilityToggling: togglingModels,
									onVisibilityToggle: (modelId, visible) => {
										control({
											action: "set-model-visibility",
											model: modelId,
											visible,
											account: status.visibility?.account ?? ""
										});
									}
								})
							}) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: tabPanelStyle,
								children: [status.credits === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									style: quotaListStyle,
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", {
										style: quotaTitleStyle,
										children: t("creditsDetailHeading")
									}), status.credits.accounts.filter((account) => account.packageName === "enterprise" || account.remain > 0 || account.unlimited === true).map((account, index) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(CreditBar, {
										label: account.packageName === "enterprise" ? t("packageEnterprise") : account.packageName,
										remain: account.remain,
										size: account.size,
										unlimited: account.unlimited,
										t
									}, `${account.packageName}-${String(index)}`))]
								}), status.models === void 0 || status.models.length === 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									style: quotaListStyle,
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", {
										style: quotaTitleStyle,
										children: t("modelsHeading")
									}), status.models.filter((model) => model.free === true || (model.badges?.length ?? 0) > 0).map((model) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ModelOfferRow, {
										model,
										t
									}, model.id))]
								})]
							})
						] }) : null,
						status?.status === "signed-out" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							style: status.reason === void 0 ? bodyStyle$1 : errorStyle,
							children: status.reason ?? t(variant.signedOutKey)
						}), assistCode === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(AssistBlock, {
							t,
							variant,
							failureSummary: status.reason ?? t(assistSummaryKey(assistCode, variant)),
							busy,
							onRecheck: () => {
								manualRefresh();
							}
						})] }) : null,
						status?.status === "error" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							style: errorStyle,
							children: status.message
						}) : null
					]
				}) : null]
			});
		}
		//#endregion
		//#region src/client/WorkBuddyProbeControl.tsx
		/**
		* Per-model reasoning-effort entry beside the Composer's model selector.
		*
		* Interaction follows the Fast Mode control `dsh-codex-connect` ships in this
		* same seat, which is the established shape for composer chrome here:
		*
		* - a **static inline label** next to the icon names the feature ("Reasoning
		*   levels"), set smaller and dimmer than the surrounding chrome so it reads as
		*   an annotation on the icon. It never carries state: the verified levels
		*   already appear in the model dropdown (the adapter exposes them as
		*   selectable efforts), so repeating them here would duplicate the real answer
		*   and make the label's width jump as results change.
		* - a **hover/focus tooltip** carries the state and the click's purpose, the way
		*   Fast Mode's tooltip explains its current speed.
		* - the **confirmation** is a small bubble anchored to the control, not a
		*   `window.confirm`. Probing spends real credit, so a confirmation stays — but
		*   it belongs next to the thing it acts on, sized to one line plus two small
		*   buttons.
		*
		* @module dsh-workbuddy-connect/client/probe-control
		*/
		/**
		* The card (and therefore the routes) a selected provider belongs to.
		*
		* The control serves both WorkBuddy providers from one seat, so the provider id
		* is what selects the status and probe endpoints. Returning `undefined` for any
		* other provider is what keeps the icon off every non-WorkBuddy model.
		*/
		function cardVariantFor(provider) {
			return CARD_VARIANTS.find((card) => card.id === provider);
		}
		/** How often the control re-checks state when the window regains focus. */
		const RECONCILE_MS = 6e4;
		const wrapperStyle = {
			display: "inline-flex",
			position: "relative",
			alignItems: "center",
			transform: "translateY(2px)",
			marginRight: -8
		};
		const buttonStyle$1 = {
			display: "inline-flex",
			alignItems: "center",
			justifyContent: "center",
			gap: 2,
			height: 30,
			padding: "0 6px",
			border: 0,
			borderRadius: 8,
			background: "transparent",
			color: "var(--dsw-alias-label-secondary)",
			font: "inherit",
			whiteSpace: "nowrap",
			cursor: "pointer"
		};
		/**
		* The inline label. Smaller and dimmer than the surrounding chrome on purpose:
		* it names the feature, so it should read as an annotation attached to the icon
		* rather than compete with the adjacent model selector.
		*/
		const labelStyle = {
			fontSize: 11,
			lineHeight: "16px",
			color: "var(--dsw-alias-label-tertiary)"
		};
		/** Tooltip bubble: the Fast Mode shape (nowrap, one line, above the control). */
		const tooltipStyle = {
			position: "absolute",
			left: "50%",
			bottom: "calc(100% + 8px)",
			zIndex: 1e3,
			transform: "translateX(-50%)",
			padding: "4px 8px",
			borderRadius: 6,
			background: "var(--dsw-specific-tip, #1f2329)",
			boxShadow: "var(--dsw-shadow-lv2)",
			color: "var(--dsw-alias-label-primary, #fff)",
			fontSize: 12,
			lineHeight: "18px",
			whiteSpace: "nowrap",
			pointerEvents: "none"
		};
		/** Confirmation bubble: same anchor, but interactive and allowed to wrap. */
		const confirmStyle = {
			position: "absolute",
			right: 0,
			bottom: "calc(100% + 8px)",
			zIndex: 1001,
			display: "flex",
			flexDirection: "column",
			gap: 8,
			width: 260,
			padding: "10px 12px",
			border: "1px solid var(--dsw-alias-border-l2)",
			borderRadius: 8,
			background: "var(--dsw-alias-bg-layer-1, #fff)",
			boxShadow: "var(--dsw-shadow-lv2)",
			color: "var(--dsw-alias-label-primary)",
			fontSize: 12,
			lineHeight: "18px"
		};
		const confirmRowStyle = {
			display: "flex",
			justifyContent: "flex-end",
			gap: 8
		};
		const confirmButtonStyle = {
			padding: "3px 10px",
			border: "1px solid var(--dsw-alias-border-l2)",
			borderRadius: 6,
			background: "transparent",
			color: "inherit",
			font: "inherit",
			fontSize: 12,
			cursor: "pointer"
		};
		/**
		* Primary action inside the confirmation bubble.
		*
		* The fill and its text colour must come as a pair: `brand-primary` resolves to
		* a light accent in this theme, so hardcoding `color: #fff` on top of it renders
		* white-on-white. `button-primary-fill` + `label-primary-foreground` is the
		* theme's own pair for exactly this, and is what `dsh-codex-connect` uses for
		* the same job.
		*/
		const primaryButtonStyle$1 = {
			...confirmButtonStyle,
			border: "1px solid var(--dsw-alias-button-primary-fill)",
			background: "var(--dsw-alias-button-primary-fill)",
			color: "var(--dsw-alias-label-primary-foreground)"
		};
		/**
		* Result note: a single line + a dismiss button, anchored to the control's
		* right side. Smaller than the confirmation bubble because it carries an
		* *outcome*, not a *decision* — the work is done, the user only has to read
		* and dismiss.
		*/
		const noteStyle = {
			position: "absolute",
			right: 0,
			bottom: "calc(100% + 8px)",
			zIndex: 1001,
			display: "flex",
			alignItems: "center",
			gap: 12,
			padding: "6px 10px",
			border: "1px solid var(--dsw-alias-border-l2)",
			borderRadius: 8,
			background: "var(--dsw-alias-bg-layer-1)",
			boxShadow: "var(--dsw-shadow-lv2)",
			color: "var(--dsw-alias-label-primary)",
			fontSize: 12,
			lineHeight: "18px",
			whiteSpace: "nowrap"
		};
		/**
		* The note's dismiss action. Outlined rather than bare text: inside an already
		* bordered bubble, an unbordered word does not read as something you can click.
		* Matches the outlined pill convention the plugin's other secondary actions use.
		*/
		const noteDismissStyle = {
			padding: "2px 8px",
			border: "1px solid var(--dsw-alias-border-l2)",
			borderRadius: 6,
			background: "transparent",
			color: "var(--dsw-alias-label-secondary)",
			font: "inherit",
			fontSize: 12,
			lineHeight: "18px",
			cursor: "pointer"
		};
		/**
		* The feature's static inline label. Deliberately not a state readout — see the
		* module comment.
		*/
		function useLabel(t) {
			return t("probeLabel");
		}
		/** Pick the model's recorded observation out of the probe section. */
		function resultFor(status, model) {
			if (status.status !== "signed-in") return void 0;
			return status.probe?.results.find((result) => result.id === model);
		}
		/**
		* The one-line tooltip: current state first, then what a click does — the same
		* two-part shape Fast Mode uses.
		*
		* A recorded result outranks a remembered failure. `failed` only means "the last
		* run from this control did not complete"; the host can record a result for the
		* same model at any time (a detection started from the settings card, another
		* conversation, or a finished sweep), and the levels the user paid for are the
		* more useful answer than the stale failure. Failure copy is what remains when
		* there is no result to report.
		*/
		function tooltipText(t, model, state) {
			if (state.busy) return t("probeRunning", { model });
			const result = state.result;
			if (result !== void 0) {
				if (result.validation === "validating" && result.efforts.length > 0) return t("probeTooltipVerified", { levels: result.efforts.join(" / ") });
				if (result.validation === "non-validating") return t("probeTooltipNotValidating");
				return t("probeTooltipRetry");
			}
			if (state.failed) return t("probeTooltipRetry");
			return t("probeTooltipIdle", { model });
		}
		/** Model-independent shell: resolves the selection, then delegates per model. */
		function WorkBuddyProbeControl({ directory, t }) {
			const subscribe = (0, react.useCallback)((listener) => directory.subscribe(listener), [directory]);
			const snapshot = (0, react.useCallback)(() => directory.getSnapshot(), [directory]);
			const selection = (0, react.useSyncExternalStore)(subscribe, snapshot, snapshot).current;
			const card = selection === void 0 ? void 0 : cardVariantFor(selection.provider);
			const key = card === void 0 || selection === void 0 ? void 0 : `${card.id}:${selection.model}`;
			return card === void 0 || selection === void 0 || key === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ModelProbe, {
				model: selection.model,
				card,
				label: useLabel(t),
				t
			}, key);
		}
		function ModelProbe({ model, card, label, t }) {
			const [status, setStatus] = (0, react.useState)();
			const [busy, setBusy] = (0, react.useState)(false);
			const [confirming, setConfirming] = (0, react.useState)(false);
			const [tooltipVisible, setTooltipVisible] = (0, react.useState)(false);
			const [failed, setFailed] = (0, react.useState)(false);
			const [note, setNote] = (0, react.useState)();
			const inFlight = (0, react.useRef)(false);
			const mounted = (0, react.useRef)(false);
			const readSeq = (0, react.useRef)(0);
			const tooltipId = (0, react.useId)();
			const refresh = (0, react.useCallback)(async (signal) => {
				const seq = ++readSeq.current;
				const response = await fetch(card.statusPath, {
					credentials: "same-origin",
					headers: { accept: "application/json" },
					...signal === void 0 ? {} : { signal }
				});
				if (!response.ok) throw new Error(`HTTP ${response.status}`);
				const value = await response.json().catch(() => void 0);
				if (!isWorkBuddyWebStatus(value)) throw new Error(t("statusResponseInvalid"));
				if (mounted.current && !signal?.aborted && seq === readSeq.current) setStatus(value);
			}, [card.statusPath, t]);
			(0, react.useEffect)(() => {
				mounted.current = true;
				const controller = new AbortController();
				const load = () => {
					refresh(controller.signal).catch(() => {});
				};
				load();
				const timer = window.setInterval(load, RECONCILE_MS);
				window.addEventListener("focus", load);
				return () => {
					mounted.current = false;
					controller.abort();
					window.clearInterval(timer);
					window.removeEventListener("focus", load);
				};
			}, [refresh]);
			const probe = status?.status === "signed-in" ? status.probe : void 0;
			const key = status?.status === "signed-in" ? status.probeKey : void 0;
			const result = status === void 0 ? void 0 : resultFor(status, model);
			const visible = probe?.candidates.includes(model) === true || result !== void 0;
			(0, react.useEffect)(() => {
				if (result !== void 0) setFailed(false);
			}, [result]);
			(0, react.useEffect)(() => {
				setConfirming(false);
				setNote(void 0);
			}, [model]);
			const detect = async () => {
				if (key === void 0 || inFlight.current || probe?.running === true) return;
				inFlight.current = true;
				setNote(void 0);
				setConfirming(false);
				setBusy(true);
				setFailed(false);
				try {
					const response = await fetch(card.probePath, {
						method: "POST",
						credentials: "same-origin",
						headers: {
							"Content-Type": "application/json",
							"X-WorkBuddy-Probe-Key": key
						},
						body: JSON.stringify({
							action: "probe",
							model
						})
					});
					const body = await response.json();
					if (!response.ok || body.state !== "ok" || body.validation !== "validating" && body.validation !== "non-validating" || !Array.isArray(body.efforts) || !body.efforts.every((effort) => typeof effort === "string")) throw new Error("probe failed");
					if (mounted.current) {
						const completed = {
							id: model,
							name: model,
							validation: body.validation,
							efforts: body.efforts,
							probedAt: Date.now()
						};
						setNote(completed);
					}
					refresh().catch(() => {});
				} catch {
					if (mounted.current) setFailed(true);
				} finally {
					inFlight.current = false;
					if (mounted.current) setBusy(false);
				}
			};
			if (!visible) return null;
			const text = tooltipText(t, model, {
				busy,
				result,
				failed
			});
			const disabled = busy || probe?.running === true || key === void 0;
			const showTooltip = tooltipVisible && !confirming && note === void 0;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
				style: wrapperStyle,
				onMouseEnter: () => {
					setTooltipVisible(true);
				},
				onMouseLeave: () => {
					setTooltipVisible(false);
				},
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
						type: "button",
						"aria-label": text,
						"aria-describedby": showTooltip ? tooltipId : void 0,
						"aria-busy": busy,
						"aria-expanded": confirming,
						disabled,
						onClick: () => {
							setConfirming(true);
						},
						onFocus: () => {
							setTooltipVisible(true);
						},
						onBlur: () => {
							setTooltipVisible(false);
						},
						style: {
							...buttonStyle$1,
							opacity: disabled && !confirming ? .6 : 1,
							cursor: disabled ? "default" : "pointer"
						},
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("svg", {
							width: "16",
							height: "16",
							viewBox: "0 0 24 24",
							fill: "none",
							stroke: "currentColor",
							strokeWidth: "1.6",
							"aria-hidden": "true",
							focusable: "false",
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("circle", {
									cx: "12",
									cy: "12",
									r: "9"
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("circle", {
									cx: "12",
									cy: "12",
									r: "4"
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M12 12 20 4" }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("circle", {
									cx: "12",
									cy: "12",
									r: "1"
								})
							]
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: labelStyle,
							children: label
						})]
					}),
					showTooltip && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						id: tooltipId,
						role: "tooltip",
						style: tooltipStyle,
						children: text
					}),
					confirming && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
						style: confirmStyle,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("probeBubbleBody") }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							style: confirmRowStyle,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								style: confirmButtonStyle,
								onClick: () => {
									setConfirming(false);
								},
								children: t("cancel")
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								style: primaryButtonStyle$1,
								onClick: () => {
									detect();
								},
								children: t("probeConfirmAction")
							})]
						})]
					}),
					note === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
						role: "status",
						"aria-live": "polite",
						style: noteStyle,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: noteText(t, note) }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							style: noteDismissStyle,
							onClick: () => {
								setNote(void 0);
							},
							children: t("probeNoteDismiss")
						})]
					})
				]
			});
		}
		/** Compose the one-line outcome string the note bubble shows. */
		function noteText(t, result) {
			if (result.validation === "validating" && result.efforts.length > 0) return t("probeNoteVerified", { levels: result.efforts.join(" / ") });
			if (result.validation === "non-validating") return t("probeNoteNotValidating");
			return t("probeNoteUnknown");
		}
		//#endregion
		//#region src/update.ts
		/**
		* Public update metadata and bounded version checking for WorkBuddy Connect.
		*
		* Two upstreams, strictly layered so the judgement never depends on the
		* enrichment: npm's dist-tags decide whether a newer release exists, and only
		* then is GitHub's release list consulted — one request that feeds both the
		* "versions behind" count and the per-release notes. Every upstream answer is
		* treated as untrusted input: bodies are size-capped while streaming, releases
		* are re-validated on the browser side by {@link parseWorkBuddyUpdateResult}
		* before anything renders.
		*
		* This module is host/browser shared and dependency-free by design (the client
		* bundle's runtime imports stay React + local modules only).
		*
		* @module dsh-workbuddy-connect/update
		*/
		const WORKBUDDY_REPOSITORY_URL = "https://github.com/corrinehu/dsh-workbuddy-connect";
		`${WORKBUDDY_REPOSITORY_URL.replace("https://github.com", "https://api.github.com/repos")}`;
		const WORKBUDDY_RELEASE_PAGE_BASE = `${WORKBUDDY_REPOSITORY_URL}/releases/tag/`;
		/** GitHub caps one page at 100 releases; ours is far below that today. */
		const RELEASES_LIST_MAX = 100;
		const RELEASE_NAME_MAX_CHARS = 200;
		const RELEASE_NOTES_MAX_CHARS = 16e3;
		/** Parse one exact SemVer version, accepting the conventional leading `v`. */
		function parseWorkBuddyVersion(raw) {
			if (typeof raw !== "string") return void 0;
			const normalized = raw.startsWith("v") ? raw.slice(1) : raw;
			const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u.exec(normalized);
			if (match === null) return void 0;
			const rawPrerelease = match[4] === void 0 ? [] : match[4].split(".");
			if (rawPrerelease.some((identifier) => /^\d+$/u.test(identifier) && !/^(0|[1-9]\d*)$/u.test(identifier))) return void 0;
			const prerelease = rawPrerelease.map((identifier) => /^(0|[1-9]\d*)$/u.test(identifier) ? Number(identifier) : identifier);
			if (prerelease.some((identifier) => typeof identifier === "number" && !Number.isSafeInteger(identifier))) return void 0;
			const parsed = {
				major: Number(match[1]),
				minor: Number(match[2]),
				patch: Number(match[3]),
				prerelease
			};
			return [
				parsed.major,
				parsed.minor,
				parsed.patch
			].every(Number.isSafeInteger) ? parsed : void 0;
		}
		/**
		* One canonical spelling per SemVer value: leading `v` and build metadata
		* fold away, so `v0.6.4`, `0.6.4`, and `0.6.4+build` dedupe as one release.
		* Returns `undefined` for unparseable input; callers drop those first.
		*/
		function canonicalWorkBuddyVersion(version) {
			const parsed = parseWorkBuddyVersion(version);
			if (parsed === void 0) return void 0;
			return `${String(parsed.major)}.${String(parsed.minor)}.${String(parsed.patch)}` + (parsed.prerelease.length === 0 ? "" : `-${parsed.prerelease.join(".")}`);
		}
		function compareIdentifiers(left, right) {
			if (typeof left === "number" && typeof right === "number") return left < right ? -1 : left > right ? 1 : 0;
			if (typeof left === "number") return -1;
			if (typeof right === "number") return 1;
			return left < right ? -1 : left > right ? 1 : 0;
		}
		/** Compare two versions using SemVer precedence (build metadata ignored). */
		function compareWorkBuddyVersions(left, right) {
			const a = parseWorkBuddyVersion(left);
			const b = parseWorkBuddyVersion(right);
			if (a === void 0 || b === void 0) throw new TypeError("invalid WorkBuddy Connect version");
			for (const [aPart, bPart] of [
				[a.major, b.major],
				[a.minor, b.minor],
				[a.patch, b.patch]
			]) if (aPart !== bPart) return aPart < bPart ? -1 : 1;
			if (a.prerelease.length === 0 && b.prerelease.length !== 0) return 1;
			if (a.prerelease.length !== 0 && b.prerelease.length === 0) return -1;
			for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index += 1) {
				const aPart = a.prerelease[index];
				const bPart = b.prerelease[index];
				if (aPart === void 0) return -1;
				if (bPart === void 0) return 1;
				const comparison = compareIdentifiers(aPart, bPart);
				if (comparison !== 0) return comparison;
			}
			return 0;
		}
		/** Strip control characters, normalize newlines, and cap the length. */
		function cleanReleaseText(value, maxLength) {
			if (typeof value !== "string" || value.length === 0) return void 0;
			const clean = value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, "").replace(/\r\n?/gu, "\n").trim().slice(0, maxLength);
			return clean.length === 0 ? void 0 : clean;
		}
		function cleanPublishedAt(value) {
			return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/iu.test(value) ? value.slice(0, 64) : void 0;
		}
		function releasePageUrl(version) {
			return `${WORKBUDDY_RELEASE_PAGE_BASE}v${version}`;
		}
		/**
		* Validate a route response before the browser renders it. Same distrust as
		* the host side: the versions must parse, `update-available` must still hold
		* under a fresh comparison, the release URL must equal the one derived from
		* the version, and every listed release must fall in (current, latest] — a
		* host that invents content fails closed here.
		*/
		function parseWorkBuddyUpdateResult(value) {
			if (typeof value !== "object" || value === null || Array.isArray(value)) return void 0;
			const record = value;
			const currentVersion = record["currentVersion"];
			if (typeof currentVersion !== "string" || parseWorkBuddyVersion(currentVersion) === void 0) return void 0;
			if (record["status"] === "unavailable") {
				const reason = record["reason"];
				return reason === "invalid-current-version" || reason === "registry-unavailable" || reason === "invalid-registry-response" ? {
					status: "unavailable",
					currentVersion,
					reason
				} : void 0;
			}
			const latestVersion = record["latestVersion"];
			if (typeof latestVersion !== "string" || parseWorkBuddyVersion(latestVersion) === void 0) return void 0;
			if (record["status"] === "up-to-date") return {
				status: "up-to-date",
				currentVersion,
				latestVersion
			};
			if (record["status"] !== "update-available" || compareWorkBuddyVersions(latestVersion, currentVersion) <= 0) return void 0;
			const expectedUrl = releasePageUrl(latestVersion);
			if (record["releaseUrl"] !== expectedUrl) return void 0;
			if (!Array.isArray(record["releases"]) || record["releases"].length > RELEASES_LIST_MAX) return void 0;
			const seen = /* @__PURE__ */ new Set();
			const releases = [];
			for (const raw of record["releases"]) {
				if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return void 0;
				const entry = raw;
				const version = entry["version"];
				if (typeof version !== "string" || parseWorkBuddyVersion(version) === void 0) return void 0;
				if (compareWorkBuddyVersions(version, currentVersion) <= 0 || compareWorkBuddyVersions(version, latestVersion) > 0) return void 0;
				const canonical = canonicalWorkBuddyVersion(version);
				if (canonical === void 0 || seen.has(canonical)) return void 0;
				seen.add(canonical);
				const name = cleanReleaseText(entry["name"], RELEASE_NAME_MAX_CHARS);
				const notes = cleanReleaseText(entry["notes"], RELEASE_NOTES_MAX_CHARS);
				const publishedAt = cleanPublishedAt(entry["publishedAt"]);
				releases.push({
					version,
					...name === void 0 ? {} : { name },
					...notes === void 0 ? {} : { notes },
					...publishedAt === void 0 ? {} : { publishedAt }
				});
			}
			const rawVersionsBehind = record["versionsBehind"];
			if (rawVersionsBehind !== void 0 && (typeof rawVersionsBehind !== "number" || !Number.isSafeInteger(rawVersionsBehind) || rawVersionsBehind !== releases.length)) return void 0;
			return {
				status: "update-available",
				currentVersion,
				latestVersion,
				releaseUrl: expectedUrl,
				releases,
				...rawVersionsBehind === void 0 ? {} : { versionsBehind: rawVersionsBehind }
			};
		}
		//#endregion
		//#region src/client/WorkBuddyUpdateNotice.tsx
		/**
		* The bottom-right update reminder: one floating panel, rendered only while a
		* newer release exists and has not been dismissed. Each in-range release
		* shows as a collapsed title row (our release titles are written as bilingual
		* user-facing summaries, so the row doubles as the highlight line); opening
		* one reveals its notes under the markdown whitelist below.
		*/
		const DEFAULT_T = (key, _params) => String(key);
		const panelStyle = {
			display: "flex",
			flexDirection: "column",
			gap: 10,
			padding: "13px 15px",
			border: "1px solid var(--dsw-alias-border-l2)",
			borderRadius: 12,
			background: "var(--dsw-alias-bg-module-platform)",
			color: "var(--dsw-alias-label-primary)"
		};
		const overlayStyle = {
			position: "fixed",
			bottom: 16,
			right: 20,
			zIndex: 30,
			width: "min(440px, calc(100vw - 40px))",
			pointerEvents: "auto",
			maxHeight: "calc(100vh - 32px)",
			overflowY: "auto",
			boxSizing: "border-box",
			boxShadow: "0 8px 28px rgba(0, 0, 0, 0.16)"
		};
		const rowStyle = {
			display: "flex",
			alignItems: "center",
			justifyContent: "space-between",
			gap: 12,
			flexWrap: "wrap"
		};
		const titleStyle = {
			margin: 0,
			fontSize: 14,
			lineHeight: "20px",
			fontWeight: 600
		};
		const bodyStyle = {
			margin: 0,
			color: "var(--dsw-alias-label-secondary)",
			fontSize: 13,
			lineHeight: "20px"
		};
		const sectionStyle = {
			display: "flex",
			flexDirection: "column",
			gap: 6
		};
		const releaseRowStyle = {
			display: "flex",
			alignItems: "flex-start",
			gap: 8,
			padding: "7px 9px",
			borderRadius: 7,
			background: "var(--dsw-alias-bg-layer-2, rgba(0, 0, 0, 0.04))",
			border: 0,
			width: "100%",
			boxSizing: "border-box",
			color: "inherit",
			font: "inherit",
			fontSize: 13,
			lineHeight: "19px",
			textAlign: "left",
			cursor: "pointer",
			overflowWrap: "anywhere"
		};
		const buttonStyle = {
			display: "inline-flex",
			alignItems: "center",
			justifyContent: "center",
			boxSizing: "border-box",
			minHeight: 32,
			padding: "4px 11px",
			border: "1px solid var(--dsw-alias-border-l2)",
			borderRadius: 7,
			background: "var(--dsw-alias-bg-layer-1)",
			color: "var(--dsw-alias-label-primary)",
			font: "inherit",
			fontSize: 12,
			lineHeight: "20px",
			whiteSpace: "nowrap",
			cursor: "pointer"
		};
		const primaryButtonStyle = {
			...buttonStyle,
			borderColor: "var(--dsw-alias-button-primary-fill)",
			background: "var(--dsw-alias-button-primary-fill)",
			color: "var(--dsw-alias-label-primary-foreground)"
		};
		const textButtonStyle = {
			border: 0,
			padding: 0,
			background: "transparent",
			color: "var(--dsw-alias-brand-primary)",
			font: "inherit",
			fontSize: 12,
			lineHeight: "20px",
			cursor: "pointer",
			textDecoration: "underline",
			textUnderlineOffset: 2
		};
		const promptRowStyle = {
			display: "flex",
			alignItems: "center",
			gap: 8,
			padding: "7px 8px 7px 10px",
			borderRadius: 7,
			background: "var(--dsw-alias-bg-layer-2, rgba(0, 0, 0, 0.06))"
		};
		const promptTextStyle = {
			flex: "1 1 auto",
			minWidth: 0,
			margin: 0,
			padding: 0,
			background: "transparent",
			color: "var(--dsw-alias-label-primary)",
			fontSize: 12,
			lineHeight: "19px",
			whiteSpace: "pre-wrap",
			overflowWrap: "anywhere"
		};
		const notesStyle = {
			maxHeight: 220,
			overflowY: "auto",
			margin: "4px 0 0",
			padding: "9px 10px",
			borderRadius: 7,
			background: "var(--dsw-alias-bg-layer-2, rgba(0, 0, 0, 0.06))",
			color: "var(--dsw-alias-label-secondary)",
			fontSize: 12,
			lineHeight: "19px",
			overflowWrap: "anywhere"
		};
		const notesListStyle = {
			margin: "4px 0",
			paddingLeft: 18
		};
		const notesHeadingStyle = {
			margin: "0 0 4px",
			fontSize: 12,
			lineHeight: "19px",
			fontWeight: 600,
			color: "var(--dsw-alias-label-primary)"
		};
		async function copyAgentPrompt(prompt) {
			try {
				if (navigator.clipboard?.writeText === void 0) return false;
				await navigator.clipboard.writeText(prompt);
				return true;
			} catch {
				return false;
			}
		}
		/** Only same-origin GitHub links may render as anchors; everything else is text. */
		function safeReleaseUrl(value) {
			try {
				const url = new URL(value);
				return url.protocol === "https:" && url.hostname === "github.com" ? url.href : void 0;
			} catch {
				return;
			}
		}
		function renderInlineMarkdown(text, keyPrefix) {
			const tokens = /(?:\*\*[^*]+\*\*|\[[^\]]+\]\(https:\/\/[^)\s]+\)|https:\/\/[^\s<]+)/gu;
			const children = [];
			let lastIndex = 0;
			let match;
			let tokenIndex = 0;
			while ((match = tokens.exec(text)) !== null) {
				if (match.index > lastIndex) children.push(text.slice(lastIndex, match.index));
				const token = match[0];
				const bold = /^\*\*([^*]+)\*\*$/u.exec(token);
				const markdownLink = /^\[([^\]]+)\]\((https:\/\/[^)\s]+)\)$/u.exec(token);
				const bareUrl = /^https:\/\/[^\s<]+$/u.test(token) ? token.replace(/[.,]$/u, "") : void 0;
				if (bold !== null) children.push(/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: bold[1] ?? "" }, `${keyPrefix}-bold-${tokenIndex}`));
				else if (markdownLink !== null) {
					const label = markdownLink[1] ?? token;
					const href = markdownLink[2] === void 0 ? void 0 : safeReleaseUrl(markdownLink[2]);
					children.push(href === void 0 ? label : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("a", {
						href,
						target: "_blank",
						rel: "noopener noreferrer",
						children: label
					}, `${keyPrefix}-link-${tokenIndex}`));
				} else if (bareUrl !== void 0) {
					const href = safeReleaseUrl(bareUrl);
					children.push(href === void 0 ? token : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("a", {
						href,
						target: "_blank",
						rel: "noopener noreferrer",
						children: token
					}, `${keyPrefix}-url-${tokenIndex}`));
				} else children.push(token);
				lastIndex = match.index + token.length;
				tokenIndex += 1;
			}
			if (lastIndex < text.length) children.push(text.slice(lastIndex));
			return children;
		}
		function renderReleaseNotes(markdown) {
			const content = [];
			let bullets = [];
			const flushBullets = () => {
				if (bullets.length === 0) return;
				content.push(/* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", {
					style: notesListStyle,
					children: bullets
				}, `list-${content.length}`));
				bullets = [];
			};
			markdown.split("\n").forEach((line, index) => {
				const trimmed = line.trim();
				const bullet = /^[-*]\s+(.+)$/u.exec(trimmed);
				const heading = /^#{1,6}\s+(.+)$/u.exec(trimmed);
				if (bullet !== null) bullets.push(/* @__PURE__ */ (0, react_jsx_runtime.jsx)("li", { children: renderInlineMarkdown(bullet[1] ?? "", `item-${index}`) }, `item-${index}`));
				else if (heading !== null) {
					flushBullets();
					content.push(/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h4", {
						style: notesHeadingStyle,
						children: renderInlineMarkdown(heading[1] ?? "", `heading-${index}`)
					}, `heading-${index}`));
				} else if (trimmed !== "") {
					flushBullets();
					content.push(/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						style: {
							...bodyStyle,
							fontSize: 12,
							lineHeight: "19px"
						},
						children: renderInlineMarkdown(trimmed, `paragraph-${index}`)
					}, `paragraph-${index}`));
				} else flushBullets();
			});
			flushBullets();
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				style: notesStyle,
				children: content
			});
		}
		/** One in-range release: a collapsed title row that opens its notes. */
		function ReleaseRow({ release, t }) {
			const [open, setOpen] = (0, react.useState)(false);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
				type: "button",
				style: releaseRowStyle,
				"aria-expanded": open,
				onClick: () => {
					setOpen(!open);
				},
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					"aria-hidden": true,
					children: open ? "▾" : "▸"
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					style: {
						flex: "1 1 auto",
						minWidth: 0
					},
					children: release.name ?? `v${release.version}`
				})]
			}), open ? release.notes === void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
				style: {
					...bodyStyle,
					fontSize: 12,
					padding: "4px 9px 0",
					margin: 0
				},
				children: t("releaseNotesUnavailable")
			}) : renderReleaseNotes(release.notes) : null] });
		}
		/** Bottom-right reminder registered in the shell.overlay list seat. */
		function WorkBuddyUpdateOverlay({ t = DEFAULT_T, updater }) {
			if (updater === void 0) return null;
			const snapshot = (0, react.useSyncExternalStore)(updater.subscribe, updater.getSnapshot, updater.getSnapshot);
			const latestVersion = snapshot.latestVersion;
			const [copied, setCopied] = (0, react.useState)(false);
			const [copyFailed, setCopyFailed] = (0, react.useState)(false);
			const [recheckRequested, setRecheckRequested] = (0, react.useState)(false);
			const noticeKey = latestVersion === void 0 ? void 0 : `${snapshot.currentVersion}:${latestVersion}`;
			if (!(recheckRequested && (snapshot.status === "checking" || snapshot.status === "unavailable")) && (snapshot.status !== "update-available" || noticeKey === void 0 || snapshot.dismissedNotice === noticeKey)) return null;
			const available = snapshot.status === "update-available";
			const releases = snapshot.releases ?? [];
			const agentPrompt = t("agentUpgradePrompt", { repository: WORKBUDDY_REPOSITORY_URL });
			const copy = async () => {
				setCopyFailed(false);
				const ok = await copyAgentPrompt(agentPrompt);
				setCopied(ok);
				setCopyFailed(!ok);
			};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: {
					...panelStyle,
					...overlayStyle
				},
				role: "status",
				"aria-label": t("updateNoticeLabel"),
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: rowStyle,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", {
							style: titleStyle,
							children: available ? t("newVersionAvailable", { version: latestVersion }) : t("updateNoticeLabel")
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							style: buttonStyle,
							"aria-label": t("dismissUpdate"),
							onClick: () => {
								setRecheckRequested(false);
								if (noticeKey !== void 0) updater.dismiss(noticeKey);
							},
							children: t("dismissUpdate")
						})]
					}),
					available ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
						style: bodyStyle,
						children: [t("versionSummary", {
							current: snapshot.currentVersion,
							latest: latestVersion
						}), snapshot.versionsBehind === void 0 ? ` · ${t("versionsBehindUnknown")}` : ` · ${t("versionsBehind", { count: snapshot.versionsBehind })}`]
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: sectionStyle,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", {
							style: titleStyle,
							children: t("releasesHeading")
						}), releases.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							style: bodyStyle,
							children: t("releaseListUnavailable")
						}) : releases.map((release) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ReleaseRow, {
							release,
							t
						}, release.version))]
					})] }) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						style: bodyStyle,
						children: t("updateCheckUnavailable")
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: sectionStyle,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: promptRowStyle,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", {
									style: promptTextStyle,
									children: agentPrompt
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									style: buttonStyle,
									onClick: () => {
										copy();
									},
									children: copied ? t("agentPromptCopied") : t("copyForAgent")
								})]
							}),
							copyFailed ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								style: {
									...bodyStyle,
									fontSize: 12,
									margin: 0
								},
								children: t("agentPromptCopyFailed")
							}) : null,
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: rowStyle,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									style: primaryButtonStyle,
									disabled: !available,
									onClick: () => {
										setRecheckRequested(true);
										updater.refresh(true);
									},
									children: snapshot.status === "checking" ? t("checkingForUpdates") : t("recheckAfterUpgrade")
								}), snapshot.releaseUrl === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("a", {
									href: snapshot.releaseUrl,
									target: "_blank",
									rel: "noopener noreferrer",
									style: textButtonStyle,
									children: t("openReleasePage")
								})]
							}),
							recheckRequested && snapshot.status === "update-available" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								style: {
									...bodyStyle,
									fontSize: 12,
									margin: 0
								},
								children: t("upgradeStillAvailable", { version: snapshot.currentVersion })
							}) : null
						]
					})
				]
			});
		}
		//#endregion
		//#region src/client/update-store.ts
		/**
		* Browser-owned cache and observable state for the update reminder.
		*
		* One reminder for the whole bundle — the check compares this npm package's
		* own version, so both provider cards share it. The cache is localStorage
		* with a 7-day TTL and the current version embedded, so an upgrade
		* invalidates it by itself. `unavailable` answers are never cached: the next
		* mount retries, and one in-page retry is scheduled after five minutes while
		* the page stays open.
		*/
		const WORKBUDDY_UPDATE_CACHE_KEY = "dsh-workbuddy-connect:update-check";
		const WORKBUDDY_UPDATE_DISMISSED_KEY = "dsh-workbuddy-connect:update-dismissed";
		/** Retry transient update-check failures while the page remains open. */
		const WORKBUDDY_UPDATE_RECHECK_MS = 3e5;
		/** The reminder's own fetch deadline, independent of the host's upstream one. */
		const ROUTE_TIMEOUT_MS = 3e4;
		function storage() {
			try {
				return typeof localStorage === "undefined" ? void 0 : localStorage;
			} catch {
				return;
			}
		}
		function resultSnapshot(result, dismissedNotice) {
			return {
				status: result.status,
				currentVersion: result.currentVersion,
				...result.status === "up-to-date" || result.status === "update-available" ? { latestVersion: result.latestVersion } : {},
				...result.status === "update-available" ? {
					releaseUrl: result.releaseUrl,
					releases: result.releases,
					...result.versionsBehind === void 0 ? {} : { versionsBehind: result.versionsBehind }
				} : {},
				...dismissedNotice === void 0 ? {} : { dismissedNotice }
			};
		}
		/** Observable browser state behind the bottom-right reminder. */
		var WorkBuddyUpdateStore = class {
			currentVersion;
			snapshot;
			listeners = /* @__PURE__ */ new Set();
			request;
			disposed = false;
			recheckTimer;
			constructor(currentVersion) {
				this.currentVersion = currentVersion;
				this.snapshot = {
					status: "idle",
					currentVersion
				};
			}
			getSnapshot = () => this.snapshot;
			subscribe = (listener) => {
				this.listeners.add(listener);
				return () => {
					this.listeners.delete(listener);
				};
			};
			setSnapshot(next) {
				if (this.disposed) return;
				this.snapshot = next;
				for (const listener of this.listeners) listener();
			}
			dismissedNotice() {
				try {
					const value = storage()?.getItem(WORKBUDDY_UPDATE_DISMISSED_KEY);
					return value === null || value === "" ? void 0 : value;
				} catch {
					return;
				}
			}
			readCached() {
				try {
					const raw = storage()?.getItem(WORKBUDDY_UPDATE_CACHE_KEY);
					if (raw === null || raw === void 0) return void 0;
					const cached = JSON.parse(raw);
					if (!Number.isSafeInteger(cached.checkedAt) || cached.checkedAt > Date.now() || Date.now() - cached.checkedAt > 6048e5) return void 0;
					const result = parseWorkBuddyUpdateResult(cached.result);
					if (result === void 0 || result.status === "unavailable") return void 0;
					return {
						result,
						checkedAt: cached.checkedAt
					};
				} catch {
					return;
				}
			}
			writeCached(result, checkedAt) {
				try {
					if (result.status === "unavailable") storage()?.removeItem(WORKBUDDY_UPDATE_CACHE_KEY);
					else storage()?.setItem(WORKBUDDY_UPDATE_CACHE_KEY, JSON.stringify({
						checkedAt,
						result
					}));
				} catch {}
			}
			acceptResult(result) {
				if (this.disposed) return;
				const checkedAt = Date.now();
				this.writeCached(result, checkedAt);
				const next = resultSnapshot(result, this.dismissedNotice());
				if (result.status === "unavailable" && this.snapshot.latestVersion !== void 0) next.latestVersion = this.snapshot.latestVersion;
				this.setSnapshot({
					...next,
					checkedAt
				});
				if (result.status === "unavailable") this.recheckTimer = setTimeout(() => {
					this.refresh(true);
				}, WORKBUDDY_UPDATE_RECHECK_MS);
			}
			/** Reuse a result for a week; force bypasses the cache. */
			async refresh(force = false) {
				if (this.disposed || this.request !== void 0) return;
				clearTimeout(this.recheckTimer);
				this.recheckTimer = void 0;
				const controller = new AbortController();
				this.request = controller;
				const timer = setTimeout(() => {
					controller.abort(/* @__PURE__ */ new Error("update route timed out"));
				}, ROUTE_TIMEOUT_MS);
				this.setSnapshot({
					status: "checking",
					currentVersion: this.currentVersion,
					...this.snapshot.latestVersion === void 0 ? {} : { latestVersion: this.snapshot.latestVersion },
					...this.snapshot.dismissedNotice === void 0 ? {} : { dismissedNotice: this.snapshot.dismissedNotice }
				});
				try {
					if (!force) {
						const cached = this.readCached();
						if (cached !== void 0 && cached.result.currentVersion === this.currentVersion) {
							this.setSnapshot({
								...resultSnapshot(cached.result, this.dismissedNotice()),
								checkedAt: cached.checkedAt
							});
							return;
						}
					}
					const response = await fetch(WORKBUDDY_UPDATE_PATH, {
						method: "GET",
						headers: { accept: "application/json" },
						credentials: "same-origin",
						signal: controller.signal
					});
					const value = await response.json().catch(() => void 0);
					const result = response.ok ? parseWorkBuddyUpdateResult(value) : void 0;
					this.acceptResult(result ?? {
						status: "unavailable",
						currentVersion: this.currentVersion,
						reason: "registry-unavailable"
					});
				} catch {
					if (!this.disposed) this.acceptResult({
						status: "unavailable",
						currentVersion: this.currentVersion,
						reason: "registry-unavailable"
					});
				} finally {
					clearTimeout(timer);
					if (this.request === controller) this.request = void 0;
				}
			}
			dismiss(notice) {
				try {
					storage()?.setItem(WORKBUDDY_UPDATE_DISMISSED_KEY, notice);
				} catch {}
				this.setSnapshot({
					...this.snapshot,
					dismissedNotice: notice
				});
			}
			dispose() {
				this.disposed = true;
				clearTimeout(this.recheckTimer);
				this.request?.abort();
				this.request = void 0;
				this.listeners.clear();
			}
		};
		//#endregion
		//#region src/version.ts
		const WORKBUDDY_CONNECT_VERSION = "0.7.1";
		//#endregion
		//#region src/client/WorkBuddyConfigPage.tsx
		/**
		* The cards' list; the page supplies no other chrome. A semantic `<ul>` —
		* each card below is an `<li>` — with the user-agent list defaults cleared so
		* only the column/gap rhythm remains, keeping the layout identical to the
		* flex column it replaced while giving the page real list semantics.
		*/
		const pageStyle = {
			display: "flex",
			flexDirection: "column",
			gap: 12,
			listStyle: "none",
			margin: 0,
			padding: 0
		};
		/**
		* Render the bundle's configuration: one status card per WorkBuddy variant.
		*
		* Both variants share one page. DSH 0.1.6 replaced the settings section's
		* keyed `settings.plugin.item` slot — dispatched once per served settings
		* namespace, which is why the two variants used to be two cards — with the
		* Plugins page's `plugins.bundle.config`, keyed by the bundle's package name.
		* A bundle therefore carries exactly one configuration entry, so the cards are
		* stacked here instead of being dispatched separately. (The 0.1.5 settings tab
		* and its two dispatched cards still exist on 0.1.5 hosts; this page only
		* mounts where the Plugins page declares its slot.)
		*/
		function WorkBuddyConfigPage({ view, t }) {
			if (view === "summary") return t("intro");
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", {
				style: pageStyle,
				children: CARD_VARIANTS.map((variant) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(WorkBuddyPluginCard, {
					t,
					variant
				}, variant.id))
			});
		}
		//#endregion
		//#region src/client/locales.ts
		/** Plugin-card copy registered under the settings.workbuddy locale namespace. */
		const en = {
			title: "DSH WorkBuddy Connect",
			intro: "Use the models in the WorkBuddy desktop app directly in DSH — zero configuration, ready out of the box.",
			titleAI: "DSH WorkBuddy AI Connect",
			introAI: "Use the models in the WorkBuddy AI international desktop app directly in DSH — zero configuration, ready out of the box.",
			expand: "Expand",
			collapse: "Collapse",
			loading: "Loading account…",
			signedOut: "Not signed in",
			signedOutHint: "Sign in once in the WorkBuddy desktop app; this plugin follows that sign-in automatically.",
			signedOutHintAI: "Sign in once in the WorkBuddy AI desktop app; this plugin follows that sign-in automatically.",
			signedInAs: "Signed in as {nickname}",
			accessTokenExpires: "Access token expires {time} (refresh is automatic)",
			creditsHeading: "Remaining credit",
			tabStatus: "Status",
			tabContext: "Context window",
			tabDetails: "Credit details",
			creditsDetailHeading: "By package",
			creditsTotal: "Total: {total}",
			creditsTotalUnlimited: "Total: Unlimited",
			unlimitedQuota: "Unlimited",
			packageEnterprise: "Enterprise quota",
			cycleResetAt: "Resets {time}",
			expiryWarningSoon: "{total} credit expires within 24 hours ({packages} packages)",
			expiryWarningWeek: "{total} credit expires within 7 days ({packages} packages)",
			expiryWarningExpired: "{total} credit has already lapsed but is still counted in the total ({packages} packages)",
			expiryExpiresAt: "Earliest: {time}",
			percentRemaining: "{percent}% remaining",
			percentUnknown: "Remaining share unknown",
			exactRemaining: "{remain} / {size} remaining",
			creditPackageUnknownSize: "{remain} remaining",
			creditsError: "Credit unavailable: {message}",
			refresh: "Refresh",
			refreshing: "Refreshing…",
			refreshModels: "Refresh model list",
			refreshingModels: "Refreshing models…",
			catalogLive: "Model list updated {time}",
			catalogSaved: "Showing the saved model list from {time}",
			catalogFallback: "Showing the built-in model list (not yet updated from WorkBuddy)",
			catalogError: "Last update failed: {message}",
			catalogAppVersion: "App version {version}",
			requestFailed: "Request failed",
			statusRefreshFailed: "Refresh failed: {message} — showing the last known state",
			statusResponseInvalid: "WorkBuddy returned an unreadable status reply",
			accountHeading: "Account",
			modelsHeading: "Model offers",
			contextHeading: "Context window",
			contextUpTo: "up to {size}",
			contextDefault: "default {size}",
			contextUnknown: "no declared context window",
			useMaximumContextWindow: "Use the largest declared context window",
			useMaximumContextWindowHint: "Applies to WorkBuddy AI models that offer a larger window.",
			visibilityIntro: "Uncheck a model to hide it from the model picker. Saved per signed-in account; chats already using a hidden model keep working.",
			visibilityStaleAccount: "The signed-in account changed — this change was not saved.",
			freeModel: "Free",
			badgeLimitedFree: "Limited-time free",
			badgeNightDiscount: "Night discount",
			badgeFreeNow: "Free now",
			rate: "{rate} credits per message",
			rateUnknown: "Price unavailable — refresh to update",
			probeLabel: "Reasoning levels",
			probeTooltipIdle: "Detect the reasoning levels {model} accepts",
			probeTooltipVerified: "Accepted levels: {levels} · click to detect again",
			probeTooltipNotValidating: "This model does not check the effort parameter",
			probeTooltipRetry: "Detection did not complete · click to retry",
			probeBubbleBody: "Send test requests to confirm the available reasoning levels. May consume a small amount of credit.",
			probeConfirmAction: "Confirm",
			probeNoteVerified: "Detected: {levels}",
			probeNoteNotValidating: "This model does not check the effort parameter",
			probeNoteUnknown: "Detection did not complete",
			probeNoteDismiss: "Got it",
			probeHeading: "Reasoning effort detection",
			probeResultNoLevels: "No tested levels were accepted.",
			probeIntro: "Some models reason but declare no selectable effort levels. Detecting which levels a model accepts sends a few real requests that may consume credit.",
			probeConsentHint: "Each detection sends test requests to one model to confirm its available reasoning levels, and may consume a small amount of credit.",
			probeStart: "Detect",
			probeRedetect: "Detect again",
			probeRunning: "Detecting {model}…",
			probeRunningGeneric: "Detecting…",
			probeClear: "Clear detected results",
			probeCandidates: "Detectable models: {count}",
			probeConfirmBody: "Send test requests to {model} to confirm its available reasoning levels. May consume a small amount of credit.",
			cancel: "Cancel",
			probeResultVerified: "Verified levels: {levels}",
			probeResultNotValidating: "This model does not check the effort parameter",
			probeResultUnknown: "Detection did not complete",
			probeResultAt: "Detected {time}",
			probeResultEmpty: "No detectable models right now.",
			probeFailed: "Detection failed: {message}",
			assistantHeading: "Let an Agent sort this out",
			assistantIntro: "Send the request below to your Agent; it will check the app location and the launch configuration for you.",
			assistantCopy: "Copy for Agent",
			assistantCopied: "Copied",
			assistantCopyFailed: "Copy failed — select the text above and copy it manually",
			assistantAfter: "When your Agent is done, come back and check again. If the DSH launch environment was changed, restart DSH first as instructed.",
			assistantRecheck: "Done — check again",
			assistantRechecking: "Checking…",
			assistantPrompt: "DSH's dsh-workbuddy-connect cannot use my {appName}: {failureSummary}. Please check the actual installation location and any existing path configuration, help the plugin use it correctly, and verify recovery. If the DSH launch environment must be changed or DSH restarted, give me clear steps; do not only set an environment variable temporarily in the current shell.",
			assistNotFound: "no usable decryption program was found",
			assistAmbiguous: "more than one WorkBuddy copy was found and none could be chosen safely",
			assistIncomplete: "the automatic search could not be completed",
			assistPathInvalid: "the configured program path is not usable",
			assistUnavailableCN: "no decryption program is configured for this platform",
			assistUnavailableAI: "no decryption program is configured for WorkBuddy AI",
			updateNoticeLabel: "WorkBuddy Connect update",
			newVersionAvailable: "New version available: {version}",
			versionSummary: "Current {current} · Latest {latest}",
			versionsBehind: "{count} release(s) behind",
			versionsBehindUnknown: "release gap unavailable",
			releasesHeading: "What changed",
			releaseListUnavailable: "The per-release summary is unavailable right now; see the release page for details.",
			releaseNotesUnavailable: "Release notes for this version are unavailable.",
			copyForAgent: "Copy for agent",
			agentPromptCopied: "Copied",
			agentPromptCopyFailed: "Copy failed — select and copy the prompt manually.",
			recheckAfterUpgrade: "Re-check after upgrading",
			upgradeStillAvailable: "Upgrade not detected yet (still {version}). After upgrading, fully quit and restart DSH, then check again.",
			dismissUpdate: "Don't remind me again",
			openReleasePage: "Open release page",
			checkingForUpdates: "Checking…",
			updateCheckUnavailable: "Update information is unavailable right now. Check again later.",
			agentUpgradePrompt: "Please open {repository}, check its latest version, and install or update the plugin \"dsh-workbuddy-connect\" in my current DSH profile following the project README (the install command differs by profile). After upgrading, fully quit and restart DSH."
		};
		const zh = {
			title: "DSH WorkBuddy Connect",
			intro: "在 DSH 中直接使用 WorkBuddy 桌面 App 包含的模型，开箱即用，无需额外配置。",
			titleAI: "DSH WorkBuddy AI Connect",
			introAI: "在 DSH 中直接使用 WorkBuddy AI 国际版桌面 App 包含的模型，开箱即用，无需额外配置。",
			expand: "展开",
			collapse: "收起",
			loading: "正在读取账号…",
			signedOut: "未登录",
			signedOutHint: "在 WorkBuddy 桌面 App 里登录一次即可，插件会自动跟随当前登录的账号。",
			signedOutHintAI: "在 WorkBuddy AI 国际版桌面 App 里登录一次即可，插件会自动跟随当前登录的账号。",
			signedInAs: "已登录：{nickname}",
			accessTokenExpires: "访问令牌 {time} 过期（自动续期）",
			creditsHeading: "剩余积分",
			tabStatus: "状态",
			tabContext: "上下文窗口",
			tabDetails: "积分详情",
			creditsDetailHeading: "按套餐",
			creditsTotal: "合计：{total}",
			creditsTotalUnlimited: "合计：不限额",
			unlimitedQuota: "不限额",
			packageEnterprise: "企业额度",
			cycleResetAt: "重置时间：{time}",
			expiryWarningSoon: "有 {total} 积分将在 24 小时内过期（{packages} 个套餐）",
			expiryWarningWeek: "有 {total} 积分将在 7 天内过期（{packages} 个套餐）",
			expiryWarningExpired: "有 {total} 积分已过期但仍计入总额（{packages} 个套餐）",
			expiryExpiresAt: "最早到期：{time}",
			percentRemaining: "剩余 {percent}%",
			percentUnknown: "剩余占比未知",
			exactRemaining: "剩余 {remain} / {size}",
			creditPackageUnknownSize: "剩余 {remain}",
			creditsError: "积分查询失败：{message}",
			refresh: "刷新",
			refreshing: "正在刷新…",
			refreshModels: "刷新模型列表",
			refreshingModels: "正在刷新模型…",
			catalogLive: "模型列表更新于 {time}",
			catalogSaved: "当前显示已保存的模型列表，更新于 {time}",
			catalogFallback: "当前显示内置模型列表（尚未从 WorkBuddy 更新）",
			catalogError: "上次更新失败：{message}",
			catalogAppVersion: "App 版本 {version}",
			requestFailed: "请求失败",
			statusRefreshFailed: "刷新失败：{message} — 当前显示的是上次成功获取的状态",
			statusResponseInvalid: "WorkBuddy 返回的状态数据无法识别",
			accountHeading: "账号",
			modelsHeading: "模型优惠",
			contextHeading: "上下文窗口",
			contextUpTo: "最高 {size}",
			contextDefault: "默认 {size}",
			contextUnknown: "未声明上下文窗口",
			useMaximumContextWindow: "使用上游声明的最大上下文窗口",
			useMaximumContextWindowHint: "仅作用于 WorkBuddy AI 中声明了更大窗口的模型。",
			visibilityIntro: "取消勾选即可在模型选择器中隐藏该模型；按当前登录账号分别保存，已在用该模型的会话不受影响。",
			visibilityStaleAccount: "登录账号已切换——本次修改未保存。",
			freeModel: "免费",
			badgeLimitedFree: "限时免费",
			badgeNightDiscount: "夜间折扣",
			badgeFreeNow: "限时免费",
			rate: "{rate} 积分/次",
			rateUnknown: "价格未知 — 刷新后更新",
			probeLabel: "推理等级",
			probeTooltipIdle: "检测 {model} 可用的推理档位",
			probeTooltipVerified: "已接受：{levels} · 点击可重新检测",
			probeTooltipNotValidating: "该模型不校验该参数",
			probeTooltipRetry: "检测未完成 · 点击重试",
			probeBubbleBody: "发送探测请求以确认可用推理档位。可能消耗少量积分。",
			probeConfirmAction: "确认检测",
			probeNoteVerified: "已检测：{levels}",
			probeNoteNotValidating: "该模型不校验该参数",
			probeNoteUnknown: "检测未完成",
			probeNoteDismiss: "知道了",
			probeHeading: "推理档位检测",
			probeResultNoLevels: "本次测试的档位均未被接受。",
			probeIntro: "部分模型具备思考能力，但没有声明可选档位。检测会发送少量真实请求，可能消耗积分。",
			probeConsentHint: "每次检测会向该模型发送探测请求，以确认可用推理档位，可能消耗少量积分。",
			probeStart: "开始检测",
			probeRedetect: "重新检测",
			probeRunning: "正在检测 {model}…",
			probeRunningGeneric: "正在检测…",
			probeClear: "清除已探测结果",
			probeCandidates: "可检测模型：{count} 个",
			probeConfirmBody: "向 {model} 发送探测请求，以确认可用推理档位。可能消耗少量积分。",
			cancel: "取消",
			probeResultVerified: "已验证接受的档位：{levels}",
			probeResultNotValidating: "该模型不校验该参数",
			probeResultUnknown: "检测未完成",
			probeResultAt: "检测于 {time}",
			probeResultEmpty: "当前没有可检测的模型。",
			probeFailed: "检测失败：{message}",
			assistantHeading: "让 Agent 帮你处理",
			assistantIntro: "把下面这段请求发给你的 Agent，它会协助检查应用位置和启动配置。",
			assistantCopy: "复制给 Agent",
			assistantCopied: "已复制",
			assistantCopyFailed: "复制失败，请手动选择上方文字复制",
			assistantAfter: "Agent 处理完成后，回到这里重新检查；如果修改了 DSH 的启动环境，请先按指引重启 DSH。",
			assistantRecheck: "已处理，重新检查",
			assistantRechecking: "正在检查…",
			assistantPrompt: "DSH 的 dsh-workbuddy-connect 无法使用我的 {appName}：{failureSummary}。请帮我检查实际安装位置和已有路径配置，让插件能正确使用它，并验证恢复结果；如果需要修改 DSH 的启动环境或重启，请给我明确的操作步骤，不要只在当前 shell 临时设置环境变量。",
			assistNotFound: "没有找到可用的解密程序",
			assistAmbiguous: "找到了多个 WorkBuddy 副本，无法安全自动选择",
			assistIncomplete: "自动定位未能完成",
			assistPathInvalid: "指定的程序路径不可用",
			assistUnavailableCN: "当前平台尚未配置解密程序",
			assistUnavailableAI: "尚未配置 WorkBuddy AI 的解密程序",
			updateNoticeLabel: "WorkBuddy Connect 更新",
			newVersionAvailable: "发现新版本：{version}",
			versionSummary: "当前 {current} · 最新 {latest}",
			versionsBehind: "落后 {count} 个版本",
			versionsBehindUnknown: "版本差距暂时不可知",
			releasesHeading: "更新内容",
			releaseListUnavailable: "各版本的更新说明暂时不可用，请到 Release 页面查看。",
			releaseNotesUnavailable: "该版本的发布说明不可用。",
			copyForAgent: "复制给 Agent",
			agentPromptCopied: "已复制",
			agentPromptCopyFailed: "复制失败，请手动选中复制。",
			recheckAfterUpgrade: "升级完成后，重新检查",
			upgradeStillAvailable: "暂未检测到升级（仍是 {version}）。升级后请完全退出并重启 DSH 再检查。",
			dismissUpdate: "不再提醒",
			openReleasePage: "打开 Release 页面",
			checkingForUpdates: "检查中…",
			updateCheckUnavailable: "暂时无法获取更新信息，请稍后再试。",
			agentUpgradePrompt: "请打开 {repository}，查看最新版本，并按项目 README 把插件 dsh-workbuddy-connect 安装或更新到我当前使用的 DSH profile（不同 profile 的安装命令不同）。升级完成后请完全退出并重启 DSH。"
		};
		//#endregion
		//#region src/client/index.tsx
		/** Stable browser-plugin name. */
		const name = "dsh-workbuddy-connect-client";
		/**
		* The bundle's package name, which is also this half's configuration key.
		*
		* The Plugins page dispatches `plugins.bundle.config` by the bundle's package
		* name, so the key has to spell exactly what the profile installs.
		*/
		const BUNDLE_NAME = "dsh-workbuddy-connect";
		/**
		* Client services required by this browser half.
		*
		* DSH 0.1.2 removed `@deepseek-ai/dsh-client-runtime` (the package that used to
		* hold the browser `ClientContext` alias and the `slots` service), so the
		* services come from narrower packages: the `slots` registry lives in
		* `@deepseek-ai/dsh-client-ui-renderer` and `locale` in
		* `@deepseek-ai/dsh-client-locale`. Neither slot owner is named here on
		* purpose: `settings.plugin.item`'s declarer (`…-ui-settings-plugins`) is
		* absent from 0.1.6+ hosts and `plugins.bundle.config`'s declarer
		* (`…-ui-plugin-manager`) is absent from 0.1.5 hosts, and the seam choice is
		* made by slot-declaration lifetime, not by activation order — `ctx.slots.inject`
		* fires whenever the declaring package commits the slot, before or after this
		* fiber starts.
		*/
		const inject = [
			"slots",
			"locale",
			"remote",
			"remote.session"
		];
		/** Prefix every guarded client contribution's degradation logs with this. */
		const CLIENT_CONTRIBUTION_FAILED = "[dsh-workbuddy-connect] client contribution failed to load (host provider unaffected):";
		/** Disposer handed back when a deferred registration degraded: nothing to undo. */
		const NOOP_DISPOSER = () => {};
		/**
		* Run ONE browser-side contribution, degrading its failure to a `console.error`
		* instead of throwing into the DSH loader. Returns the contribution's own
		* value on success, or `undefined` when it degraded — the deferred slot
		* callbacks below substitute `NOOP_DISPOSER` for that, because the slot
		* runtime always expects a disposer back.
		*
		* Every contribution is guarded at BOTH boundaries where it can throw:
		*
		* 1. the eager `ctx.slots.inject(...)` / `ctx.inject(...)` call itself, which
		*    runs synchronously inside `apply()` — e.g. a slot-API shape break such as
		*    the rc.6→rc.7 `id`→`key` rename;
		* 2. the deferred callback, which the slot runtime invokes later — when the
		*    owner commits the slot's declaration, or when the injected services
		*    arrive — long after `apply()` has returned, where no enclosing try/catch
		*    could still catch it.
		*
		* The pair is what makes the contributions independent: a failure in one
		* settings seam, or in the probe control, leaves every other registration
		* intact. Guards are for THIS browser half only; the host half reports its own
		* errors through `ctx.logger`.
		*/
		function guardClientContribution(label, fn) {
			try {
				return fn();
			} catch (error) {
				console.error(`${CLIENT_CONTRIBUTION_FAILED} ${label}`, error);
				return;
			}
		}
		/**
		* Register the card copy and both settings-surface seams, one guarded
		* contribution at a time.
		*
		* A DSH slot-API breaking change degrades to a `console.error` per
		* contribution instead of throwing into the DSH loader and raising the red
		* "Failed to load plugins" banner; because each contribution carries its own
		* guard, one failing registration never takes the others with it (the old
		* settings cards survive a broken Plugins-page seam, and the probe control
		* survives either). The host provider keeps working throughout: the
		* `workbuddy` model channel is unaffected, and `dsh-workbuddy-connect status`
		* reports host health via the heartbeat file.
		*
		* The tests import this function directly (`tests/client-fallback.spec.ts`),
		* so its isolation semantics are pinned against the real entry — keep any
		* change to the guarded structure in sync with that spec.
		*/
		function apply(ctx) {
			const namespace = "settings.workbuddy";
			guardClientContribution("settings copy", () => {
				ctx.effect(() => ctx.locale.register(namespace, {
					zh,
					en
				}), "dsh-workbuddy-connect: settings copy");
			});
			const t = ctx.locale.bind(namespace);
			const updater = new WorkBuddyUpdateStore(WORKBUDDY_CONNECT_VERSION);
			guardClientContribution("update reminder lifecycle", () => {
				ctx.effect(() => {
					updater.refresh();
					return () => {
						updater.dispose();
					};
				}, "dsh-workbuddy-connect: update checker");
			});
			guardClientContribution("update reminder overlay", () => {
				ctx.slots.inject("shell.overlay", () => guardClientContribution("update reminder overlay", () => ctx.slots.register({
					name: "shell.overlay",
					id: "workbuddy-update",
					order: 40,
					locale: namespace,
					inject: () => ({
						t,
						updater
					})
				}, WorkBuddyUpdateOverlay)) ?? NOOP_DISPOSER);
			});
			for (const [index, variant] of CARD_VARIANTS.entries()) {
				const label = `settings.plugin.item card "${variant.id}"`;
				guardClientContribution(label, () => {
					ctx.slots.inject("settings.plugin.item", () => guardClientContribution(label, () => ctx.slots.register({
						name: "settings.plugin.item",
						key: variant.id,
						priority: 30 - index,
						inject: () => ({
							t,
							variant
						})
					}, WorkBuddyPluginCard)) ?? NOOP_DISPOSER);
				});
			}
			guardClientContribution("plugins.bundle.config page", () => {
				ctx.slots.inject("plugins.bundle.config", () => guardClientContribution("plugins.bundle.config page", () => ctx.slots.register({
					name: "plugins.bundle.config",
					key: "dsh-workbuddy-connect",
					locale: namespace
				}, WorkBuddyConfigPage)) ?? NOOP_DISPOSER);
			});
			guardClientContribution("conversation probe control", () => {
				ctx.inject(["modelDirectories"], (scope) => {
					guardClientContribution("conversation probe control", () => {
						scope.slots.inject("conversation.input.right", () => guardClientContribution("conversation probe control", () => scope.slots.register({
							name: "conversation.input.right",
							id: "workbuddy-probe",
							order: 10,
							inject: (sessionId) => ({
								directory: scope.modelDirectories.directoryFor(sessionId).store,
								t
							})
						}, WorkBuddyProbeControl)) ?? NOOP_DISPOSER);
					});
				});
			});
		}
		//#endregion
		exports.BUNDLE_NAME = BUNDLE_NAME;
		exports.apply = apply;
		exports.inject = inject;
		exports.name = name;
		return module.exports;
	}
});
