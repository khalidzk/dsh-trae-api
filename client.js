window.__ModuleLoader__.load({
	id: "dsh-trae-api",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const React = require("react");
		const h = React.createElement;

		const EDITIONS = [
			{ value: "", label: "自动探测" },
			{ value: "cn", label: "Trae CN 国内版" },
			{ value: "solo", label: "TRAE SOLO CN" },
			{ value: "sg", label: "Trae 国际版" },
			{ value: "solo-sg", label: "TRAE SOLO 国际版" },
		];
		const STAT_LABELS = {
			chat: "OpenAI Chat",
			messages: "Anthropic Messages",
			countTokens: "Token 计数",
			responses: "Responses",
			models: "模型列表",
			status: "状态查询",
		};

		const CSS = [
			".ta-root{display:flex;flex-direction:column;gap:16px;padding:20px;max-width:920px;margin:0 auto;color:var(--dsw-alias-label-primary,#111);font-size:13px;line-height:1.5;}",
			".ta-head{display:flex;flex-direction:column;gap:4px;}",
			".ta-title{font-size:16px;font-weight:600;}",
			".ta-sub{color:var(--dsw-alias-label-secondary,#666);font-size:12px;}",
			".ta-card{border:1px solid var(--dsw-alias-border-l1,#ddd);border-radius:10px;background:var(--dsw-alias-bg-layer-1,#fff);padding:14px;display:flex;flex-direction:column;gap:10px;}",
			".ta-card-head{display:flex;align-items:center;gap:10px;}",
			".ta-card-title{font-weight:600;font-size:14px;flex:1;}",
			".ta-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;}",
			".ta-label{min-width:104px;color:var(--dsw-alias-label-secondary,#555);font-size:12px;}",
			".ta-input{flex:1;min-width:200px;padding:7px 10px;border:1px solid var(--dsw-alias-border-l1,#ddd);border-radius:8px;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#111);font-size:13px;outline:none;font-family:inherit;}",
			".ta-input:focus{border-color:var(--dsw-alias-brand-primary,#4a6cf7);}",
			".ta-select{padding:7px 10px;border:1px solid var(--dsw-alias-border-l1,#ddd);border-radius:8px;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#111);font-size:13px;}",
			".ta-btn{padding:6px 14px;border:1px solid var(--dsw-alias-border-l1,#ddd);border-radius:8px;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#111);cursor:pointer;font-size:12px;white-space:nowrap;}",
			".ta-btn:hover{border-color:var(--dsw-alias-border-l2,#bbb);}",
			".ta-btn.primary{border-color:var(--dsw-alias-brand-primary,#4a6cf7);color:var(--dsw-alias-brand-primary,#4a6cf7);font-weight:600;}",
			".ta-btn:disabled{opacity:.5;cursor:default;}",
			".ta-badge{padding:2px 8px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1,#ddd);font-size:11px;color:var(--dsw-alias-label-secondary,#666);background:var(--dsw-alias-bg-layer-2,#f7f7f7);}",
			".ta-badge.on{color:var(--dsw-alias-state-success-primary,#2a9d4a);border-color:currentColor;}",
			".ta-badge.off{color:var(--dsw-alias-state-error-primary,#d33);border-color:currentColor;}",
			".ta-ok{color:var(--dsw-alias-state-success-primary,#2a9d4a);font-size:12px;}",
			".ta-err{color:var(--dsw-alias-state-error-primary,#d33);font-size:12px;}",
			".ta-muted{color:var(--dsw-alias-label-secondary,#777);font-size:12px;}",
			".ta-code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;background:var(--dsw-alias-bg-layer-2,#f7f7f7);border:1px solid var(--dsw-alias-border-l1,#eee);border-radius:6px;padding:2px 6px;}",
			".ta-pre{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;background:var(--dsw-alias-bg-layer-2,#f7f7f7);border:1px solid var(--dsw-alias-border-l1,#eee);border-radius:8px;padding:10px 12px;white-space:pre-wrap;word-break:break-all;margin:0;}",
			".ta-stats{display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:8px;}",
			".ta-stat{border:1px solid var(--dsw-alias-border-l1,#eee);border-radius:8px;padding:8px 10px;background:var(--dsw-alias-bg-layer-2,#fafafa);}",
			".ta-stat-num{font-size:16px;font-weight:600;}",
			".ta-stat-lbl{font-size:11px;color:var(--dsw-alias-label-secondary,#777);}",
		].join("\n");

		function api(path, opts) {
			return fetch("/plug-trae-api/" + path, Object.assign({ headers: { accept: "application/json" } }, opts))
				.then((res) => res.json().catch(() => ({ ok: false, error: "HTTP " + res.status })));
		}
		function post(path, body) {
			return api(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });
		}
		function errMsg(e) {
			if (e === null || e === undefined) return "未知错误";
			if (typeof e === "string") return e;
			if (typeof e.message === "string") return e.message;
			return String(e);
		}
		function fmtTime(value) {
			if (!value) return "—";
			const d = new Date(value);
			if (isNaN(d.getTime())) return String(value);
			return d.toLocaleString();
		}
		function fmtRemain(value) {
			if (!value) return "";
			const t = new Date(value).getTime() - Date.now();
			if (isNaN(t)) return "";
			if (t <= 0) return "（已过期）";
			const hours = Math.floor(t / 3600000);
			const days = Math.floor(hours / 24);
			if (days > 0) return "（剩 " + days + " 天 " + (hours % 24) + " 小时）";
			const mins = Math.floor((t % 3600000) / 60000);
			if (hours > 0) return "（剩 " + hours + " 小时 " + mins + " 分）";
			return "（剩 " + mins + " 分钟）";
		}

		function TraeApiSettings() {
			const [snap, setSnap] = React.useState(null);
			const [cfg, setCfg] = React.useState(null);
			const [form, setForm] = React.useState(null);
			const [apiKeyEdit, setApiKeyEdit] = React.useState("");
			const [status, setStatus] = React.useState(null);
			const [busy, setBusy] = React.useState("");
			const [testResult, setTestResult] = React.useState(null);
			const [copied, setCopied] = React.useState(false);

			const load = () => Promise.all([api("status"), api("config")]).then((results) => {
				const s = results[0];
				const c = results[1];
				if (s && s.ok) setSnap(s);
				if (c && c.ok && c.config) {
					setCfg(c.config);
					setForm({
						port: String(c.config.port ?? 9220),
						host: c.config.host || "127.0.0.1",
						edition: c.config.edition || "",
						baseUrl: c.config.baseUrl || "",
						maxContextTokens: String(c.config.maxContextTokens ?? 200000),
					});
					setApiKeyEdit("");
				}
				if ((s && !s.ok) || (c && !c.ok)) {
					setStatus({ kind: "err", text: "加载失败：" + errMsg((s && s.error) || (c && c.error)) });
				}
			}).catch((e) => setStatus({ kind: "err", text: errMsg(e) }));

			React.useEffect(() => { load(); }, []);

			const set = (patch) => setForm(Object.assign({}, form, patch));

			const save = () => {
				setStatus(null); setBusy("save");
				post("config", { config: {
					port: form.port,
					host: form.host,
					apiKey: apiKeyEdit,
					edition: form.edition,
					baseUrl: form.baseUrl,
					maxContextTokens: form.maxContextTokens,
				} }).then((res) => {
					setBusy("");
					if (res && res.ok) {
						setStatus({ kind: "ok", text: res.summary || "已保存。" });
						if (res.status || res.auth || res.stats) setSnap(res);
						if (res.config) {
							setCfg(res.config);
							setForm(Object.assign({}, form, {
								port: String(res.config.port ?? form.port),
								host: res.config.host || form.host,
								edition: res.config.edition || "",
								baseUrl: res.config.baseUrl || "",
								maxContextTokens: String(res.config.maxContextTokens ?? form.maxContextTokens),
							}));
							setApiKeyEdit("");
						}
					} else {
						setStatus({ kind: "err", text: "保存失败：" + errMsg(res && res.error) });
						load();
					}
				}).catch((e) => { setBusy(""); setStatus({ kind: "err", text: errMsg(e) }); load(); });
			};

			const doRefreshToken = () => {
				setStatus(null); setBusy("refresh");
				post("refresh-token", {}).then((res) => {
					setBusy("");
					setStatus({ kind: res && res.ok ? "ok" : "err", text: res && res.ok ? (res.summary || "Token 已刷新。") : errMsg(res && res.error) });
					if (res && res.ok) load();
				}).catch((e) => { setBusy(""); setStatus({ kind: "err", text: errMsg(e) }); });
			};

			const doReauth = () => {
				setStatus(null); setBusy("reauth");
				post("reauth", { edition: form ? form.edition : "" }).then((res) => {
					setBusy("");
					setStatus({ kind: res && res.ok ? "ok" : "err", text: res && res.ok ? (res.summary || "已重新解密。") : errMsg(res && res.error) });
					load();
				}).catch((e) => { setBusy(""); setStatus({ kind: "err", text: errMsg(e) }); });
			};

			const doTest = () => {
				setStatus(null); setTestResult(null); setBusy("test");
				post("test", {}).then((res) => {
					setBusy("");
					setTestResult(res || { ok: false, error: "无响应" });
					if (!res || !res.ok) setStatus({ kind: "err", text: errMsg(res && res.error) });
					else setStatus({ kind: "ok", text: res.summary || "上游连通正常。" });
				}).catch((e) => { setBusy(""); setTestResult({ ok: false, error: errMsg(e) }); setStatus({ kind: "err", text: errMsg(e) }); });
			};

			const snippet = React.useMemo(() => {
				const port = snap && snap.status ? snap.status.port : 9220;
				const key = cfg && cfg.authEnabled === false ? "（已禁用鉴权）" : "trae-local-api";
				return [
					"# Claude Code（Anthropic 兼容）",
					'export ANTHROPIC_BASE_URL="http://127.0.0.1:' + port + '"',
					'export ANTHROPIC_API_KEY="***"',
					"",
					"# Cursor / Cline / Windsurf（OpenAI 兼容）",
					"Base URL: http://127.0.0.1:" + port + "/v1",
					"API Key:  " + key,
					"Model:    claude-sonnet-4-6 / gpt-4o / auto",
				].join("\n");
			}, [snap, cfg]);

			const copySnippet = () => {
				const done = () => { setCopied(true); setTimeout(() => setCopied(false), 1600); };
				if (navigator.clipboard && navigator.clipboard.writeText) {
					navigator.clipboard.writeText(snippet).then(done).catch(() => {});
				}
			};

			if (!snap || !form || !cfg) {
				return h("div", { className: "ta-root" }, h("div", { className: "ta-muted" }, "加载中…"));
			}

			const st = snap.status || {};
			const au = snap.auth || {};
			const stats = snap.stats;
			const locked = Array.isArray(cfg.fromCordis) ? cfg.fromCordis : [];

			return h("div", { className: "ta-root" },
				h("div", { className: "ta-head" },
					h("div", { className: "ta-title" }, "Trae API 代理"),
					h("div", { className: "ta-sub" }, "把本机 Trae 的模型额度暴露为本地 OpenAI / Anthropic 兼容 API（/v1/chat/completions、/v1/messages、/v1/responses），供 Claude Code、Cursor、Cline 等工具直接调用。"),
				),

				// —— 运行状态
				h("div", { className: "ta-card" },
					h("div", { className: "ta-card-head" },
						h("span", { className: "ta-card-title" }, "运行状态"),
						h("span", { className: st.listening ? "ta-badge on" : "ta-badge off" }, st.listening ? "● 监听中" : "○ 未监听"),
						h("span", { className: st.authOk ? "ta-badge on" : "ta-badge off" }, st.authOk ? "凭证有效" : "凭证缺失"),
						h("span", { className: cfg.authEnabled ? "ta-badge" : "ta-badge off" }, cfg.authEnabled ? "API Key 鉴权" : "鉴权已禁用"),
					),
					h("div", { className: "ta-row" }, h("span", { className: "ta-label" }, "监听地址"), h("span", { className: "ta-code" }, "http://" + st.host + ":" + st.port)),
					h("div", { className: "ta-row" }, h("span", { className: "ta-label" }, "Trae 版本"), h("span", { className: "ta-code" }, String(st.edition || "").toUpperCase()), h("span", { className: "ta-muted" }, "上游 " + (st.baseUrl || "—"))),
					h("div", { className: "ta-row" }, h("span", { className: "ta-label" }, "用户 ID"), h("span", { className: "ta-code" }, au.userId || "—")),
					h("div", { className: "ta-row" }, h("span", { className: "ta-label" }, "Token 过期"),
						h("span", null, fmtTime(au.expiredAt)),
						h("span", { className: "ta-muted" }, fmtRemain(au.expiredAt))),
					h("div", { className: "ta-row" }, h("span", { className: "ta-label" }, "Refresh 过期"),
						h("span", null, fmtTime(au.refreshExpiredAt)),
						h("span", { className: "ta-muted" }, fmtRemain(au.refreshExpiredAt))),
					h("div", { className: "ta-row" },
						h("span", { className: "ta-label" }, ""),
						h("button", { className: "ta-btn", onClick: load }, "刷新状态"),
						h("button", { className: "ta-btn", disabled: busy !== "", onClick: doRefreshToken }, busy === "refresh" ? "刷新中…" : "立即刷新 Token"),
						h("button", { className: "ta-btn", disabled: busy !== "", onClick: doReauth }, busy === "reauth" ? "解密中…" : "重新解密凭证"),
						h("button", { className: "ta-btn primary", disabled: busy !== "", onClick: doTest }, busy === "test" ? "测试中…" : "测试上游连接"),
					),
					testResult && testResult.detail
						? h("div", { className: "ta-row" },
							h("span", { className: "ta-label" }, "测试结果"),
							h("span", { className: testResult.ok ? "ta-ok" : "ta-err" },
								(testResult.ok ? "✓ " : "✗ ") +
								(testResult.ok
									? "端点 " + testResult.detail.endpoint + " · 模型 " + testResult.detail.model + " · " + testResult.detail.latencyMs + "ms · HTTP " + testResult.detail.httpStatus
									: errMsg(testResult.error))),
						)
						: null,
					h("div", { className: "ta-muted" }, "「测试上游连接」会发送一个最小探针请求，约消耗少量 Trae token；「重新解密凭证」从本机 Trae IDE 的 storage.json 重新读取。"),
				),

				// —— 请求统计
				stats
					? h("div", { className: "ta-card" },
						h("div", { className: "ta-card-head" },
							h("span", { className: "ta-card-title" }, "请求统计"),
							h("span", { className: "ta-muted" }, "运行时长 " + (st.uptime || "—") + " · 最后请求 " + fmtTime(stats.lastRequestAt)),
						),
						h("div", { className: "ta-stats" },
							Object.keys(STAT_LABELS).map((key) => h("div", { className: "ta-stat", key },
								h("div", { className: "ta-stat-num" }, String((stats.requests || {})[key] ?? 0)),
								h("div", { className: "ta-stat-lbl" }, STAT_LABELS[key]),
							)).concat([h("div", { className: "ta-stat", key: "errors" },
								h("div", { className: "ta-stat-num", style: { color: stats.errors > 0 ? "var(--dsw-alias-state-error-primary,#d33)" : undefined } }, String(stats.errors ?? 0)),
								h("div", { className: "ta-stat-lbl" }, "错误"),
							)]),
						),
						stats.lastError ? h("div", { className: "ta-muted" }, "最近错误（" + stats.lastError.at + "）：" + stats.lastError.message) : null,
					)
					: null,

				// —— 服务配置
				h("div", { className: "ta-card" },
					h("div", { className: "ta-card-head" }, h("span", { className: "ta-card-title" }, "服务配置")),
					h("div", { className: "ta-row" },
						h("span", { className: "ta-label" }, "监听端口"),
						h("input", { className: "ta-input", style: { maxWidth: 120 }, type: "number", min: 1, max: 65535, value: form.port, onChange: (e) => set({ port: e.target.value }) }),
						h("span", { className: "ta-label" }, "监听地址"),
						h("select", { className: "ta-select", value: form.host, onChange: (e) => set({ host: e.target.value }) },
							h("option", { value: "127.0.0.1" }, "127.0.0.1（仅本机）"),
							h("option", { value: "0.0.0.0" }, "0.0.0.0（局域网，风险自担）"),
						),
					),
					h("div", { className: "ta-row" },
						h("span", { className: "ta-label" }, "API Key"),
						h("input", { className: "ta-input", type: "text", placeholder: "留空保持不变（当前 " + (cfg.apiKeyMasked || "默认") + "）；填 none 禁用鉴权", value: apiKeyEdit, onChange: (e) => setApiKeyEdit(e.target.value) }),
					),
					h("div", { className: "ta-row" },
						h("span", { className: "ta-label" }, "Trae 版本"),
						h("select", { className: "ta-select", value: form.edition, onChange: (e) => set({ edition: e.target.value }) },
							EDITIONS.map((ed) => h("option", { key: ed.value, value: ed.value }, ed.label)),
						),
						h("span", { className: "ta-muted" }, "用于重新解密凭证时的目标版本；留空则自动探测"),
					),
					h("div", { className: "ta-row" },
						h("span", { className: "ta-label" }, "上游地址"),
						h("input", { className: "ta-input", type: "text", placeholder: "留空按版本自动选择", value: form.baseUrl, onChange: (e) => set({ baseUrl: e.target.value }) }),
					),
					h("div", { className: "ta-row" },
						h("span", { className: "ta-label" }, "最大上下文"),
						h("input", { className: "ta-input", style: { maxWidth: 140 }, type: "number", min: 1000, max: 2000000, value: form.maxContextTokens, onChange: (e) => set({ maxContextTokens: e.target.value }) }),
						h("span", { className: "ta-muted" }, "tokens，超出自动截断早期消息"),
					),
					locked.length > 0
						? h("div", { className: "ta-muted" }, "注意：字段 " + locked.join("、") + " 被 cordis.patch.yml 的 config 锁定，此处修改重启后会被覆盖。")
						: null,
					h("div", { className: "ta-row" },
						h("button", { className: "ta-btn primary", disabled: busy !== "", onClick: save }, busy === "save" ? "保存中…" : "保存并重启代理服务"),
						h("span", { className: "ta-muted" }, "配置持久化到 $DSH_HOME/plug-trae-api.json，保存后立即生效（内部热重启，无需重启 DSH）"),
					),
				),

				// —— 客户端接入
				h("div", { className: "ta-card" },
					h("div", { className: "ta-card-head" },
						h("span", { className: "ta-card-title" }, "客户端接入示例"),
						h("button", { className: "ta-btn", onClick: copySnippet }, copied ? "已复制 ✓" : "复制"),
					),
					h("pre", { className: "ta-pre" }, snippet),
				),

				h("div", { className: "ta-row" },
					status ? h("span", { className: status.kind === "ok" ? "ta-ok" : "ta-err" }, status.text) : null,
				),
			);
		}

		function apply(ctx) {
			ctx.effect(() => {
				const tag = document.createElement("style");
				tag.dataset.plugin = "dsh-trae-api";
				tag.textContent = CSS;
				document.head.appendChild(tag);
				return () => { tag.remove(); };
			}, "dsh-trae-api: css");
			const slots = ctx.get("slots");
			if (slots === undefined) return;
			slots.inject("settings.section", () => slots.register(
				{ name: "settings.section", id: "plug-trae-api", order: 41, label: "Trae API 代理" },
				() => h(TraeApiSettings, null),
			));
		}

		exports.apply = apply;
		return module.exports;
	},
});
