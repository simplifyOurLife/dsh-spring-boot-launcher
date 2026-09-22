window.__ModuleLoader__.load({
	id: "dsh-spring-boot-launcher-ui",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		var React = require("react");
		var useState = React.useState;
		var useEffect = React.useEffect;
		var useRef = React.useRef;
		var createElement = React.createElement;

		// ─── Shared connection store (module singleton) ─────────────────
		// 复用 DSH 当前页面的 HttpOnly 登录 cookie，不保存额外令牌。
		var CONTROL_PATH = "/spring-boot-launcher";
		var RECONNECT_MS = 3000;
		var LS_KEY = "dsh-spring-boot-launcher:settings";

		function controlFetch(path, options) {
			return fetch(CONTROL_PATH + path, Object.assign({
				credentials: "same-origin", cache: "no-store",
			}, options || {}));
		}
		function discoverPort() {
			return controlFetch("/status", { signal: AbortSignal.timeout(5000) }).then(function (r) {
				if (r.status === 401) throw new Error("DSH 登录已失效，请重新打开已登录页面");
				if (r.status === 403) throw new Error("DSH 拒绝访问，请从本机同源页面打开");
				if (r.status === 404) throw new Error("服务面板原生通道未加载，请重新加载 Host 插件");
				if (r.ok === false) throw new Error("控制通道不可用：" + r.status);
				return r.json();
			}).then(function (j) {
				return j && j.service === "dsh-spring-boot-launcher"
					? Number(window.location.port || (window.location.protocol === "https:" ? 443 : 80)) : null;
			});
		}

		// ─── persisted settings (localStorage) ─────────────────────────
		// { recentDirs: [dir...], defaultProfile: { dir → profile } }
		function loadSettings() {
			try {
				return JSON.parse(localStorage.getItem(LS_KEY)) || {};
			} catch (e) { return {}; }
		}
		function saveSettings(s) {
			try { localStorage.setItem(LS_KEY, JSON.stringify(s)); } catch (e) { /* private mode */ }
		}
		function rememberDir(dir) {
			var s = loadSettings();
			s.recentDirs = (s.recentDirs || []).filter(function (d) { return d !== dir; });
			s.recentDirs.unshift(dir);
			s.recentDirs = s.recentDirs.slice(0, 8);
			saveSettings(s);
		}
		function rememberProfile(dir, profile) {
			var s = loadSettings();
			s.defaultProfile = s.defaultProfile || {};
			s.defaultProfile[dir] = profile;
			saveSettings(s);
		}
		function clearRecentDirs() {
			var s = loadSettings();
			s.recentDirs = [];
			saveSettings(s);
		}

		var store = {
			services: {},      // projectKey → {running, status, port, mode, logPath, projectDir, ...}
			logs: {},          // projectKey → accumulated log text
			streamEnded: {},   // projectKey → terminal status once stream drains
			inspect: null,     // last inspect result for the start panel
			inspectTargetDir: null,
			startDir: "",      // typed dir in the advanced start input
			discovered: [],    // workspace projects from /discover
			discovering: false,
			selectedProject: null, // dir of the project card the user picked
			projectInspect: null,  // inspect result for the selected project
			workspaces: [],    // [{path,title}] fed by the slot inject factory
			selectedKey: null,
			servicesCollapsed: false, // session-services column folded (log full width)
			busyKeys: {},           // projectKey → "starting" | "stopping" (until WS confirms)
			panelOpen: false,  // full-screen management panel visibility
			connected: false,
			port: null,
			lastError: null,
			ws: null,
			reconnectTimer: null,
			connecting: false,
			listeners: new Set(),

			subscribe: function (fn) {
				var self = this;
				this.listeners.add(fn);
				return function () { self.listeners.delete(fn); };
			},
			emit: function () {
				this.listeners.forEach(function (fn) { fn(); });
			},

			// Called by the slot inject factory with the workspaces service's
			// live list — each workspace view {workspaceId, path, title, ...}.
			setWorkspaces: function (views) {
				this.workspaces = (views || []).map(function (v) {
					return { path: v.path, title: v.title || (v.path || "").split("\\").pop() };
				});
				this.emit();
			},

			// Discover launchable projects under every registered workspace.
			discover: function () {
				var self = this;
				if (!this.port || !this.workspaces.length) return;
				self.discovering = true;
				self.discovered = [];
				self.emit();
				var jobs = self.workspaces.map(function (w) {
					return controlFetch("/discover?dir=" + encodeURIComponent(w.path))
						.then(function (r) { return r.json(); })
						.then(function (j) {
							if (j && j.why) throw new Error(j.why);
							return (j && j.projects) || [];
						})
						.catch(function (error) {
							self.lastError = '扫描失败：' + w.path + ' — ' + error.message;
							self.emit();
							return [];
						});
				});
				Promise.all(jobs).then(function (lists) {
					var seen = {};
					var all = [];
					lists.forEach(function (l) {
						l.forEach(function (p) {
							if (!seen[p.dir]) { seen[p.dir] = true; all.push(p); }
						});
					});
						self.discovered = all;
						self.discovering = false;
						self.emit();
						// externalPort arrives WITH the discover payload now
						// (host-side TCP probe — browser fetches can't tell
						// CORS-blocked from connection-refused).
					});
				},

				// Select a discovered project → inspect it for profiles. Still
				// needed as the FALLBACK path: an older host's /discover returns
			// rows WITHOUT profiles, so clicking a row hydrates them.
			selectProject: function (dir) {
				var self = this;
				self.selectedProject = dir;
				self.emit();
				rememberDir(dir);
				if (!self.port) return;
				var known = self.discovered.filter(function (c) { return c.dir === dir; })[0];
				if (known && known.profiles && known.profiles.length > 0) return; // already hydrated
				controlFetch("/inspect?dir=" + encodeURIComponent(dir))
					.then(function (r) { return r.json(); })
					.then(function (j) {
						if (self.selectedProject !== dir) return; // stale
						self.projectInspect = j;
						if (known && j && j.profiles) {
							known.profiles = j.profiles;
							known.activeProfile = j.activeProfile;
							known.port = j.port;
						}
						self.emit();
					})
					.catch(function (e) {
						if (self.selectedProject === dir) {
							self.projectInspect = { matched: false, why: String(e.message || e) };
							self.emit();
						}
					});
			},

			// Launch the selected project with the chosen profile.
			launchSelected: function (profile) {
				var dir = this.selectedProject;
				if (!dir) return Promise.reject(new Error("no project selected"));
				if (profile) rememberProfile(dir, profile);
				return this.startService({ dir: dir, profile: profile || undefined });
			},

			connect: function () {
				var self = this;
				if (this.connecting || this.ws) return;
				this.connecting = true;
				discoverPort().then(function (port) {
					self.connecting = false;
					if (port === null) {
						self.connected = false;
						self.lastError = "未找到已认证的 DSH 服务面板通道";
						self.emit();
						self.scheduleReconnect();
						return;
					}
					self.port = port;
					var ws;
					try {
						ws = new WebSocket((window.location.protocol === "https:" ? "wss://" : "ws://") + window.location.host + CONTROL_PATH + "/ws");
					} catch (e) {
						self.scheduleReconnect();
						return;
					}
					self.ws = ws;

					ws.onopen = function () {
						self.connected = true;
						self.lastError = null;
						self.emit();
					};
					ws.onmessage = function (event) {
						var msg;
						try { msg = JSON.parse(event.data); } catch (e) { return; }
					if (msg.type === "snapshot") {
						// Anchor startedAt from the snapshot's uptimeMs so
						// already-running services show their TRUE age, then
						// tick live from here.
						var services = msg.services || {};
						Object.keys(services).forEach(function (k) {
							if (services[k].running) {
								services[k].startedAt = Date.now() - (services[k].uptimeMs || 0);
							}
						});
						self.services = services;
					} else if (msg.type === "removed") {
						delete self.services[msg.projectKey];
						delete self.logs[msg.projectKey];
						delete self.streamEnded[msg.projectKey];
						delete self.busyKeys[msg.projectKey];
					} else if (msg.type === "log") {
						self.logs[msg.projectKey] = (self.logs[msg.projectKey] || "") + msg.delta;
						// Mirror the server-side cap so a long session
						// doesn't grow the page heap without bound.
						if (self.logs[msg.projectKey].length > 512 * 1024) {
							self.logs[msg.projectKey] = self.logs[msg.projectKey].slice(-512 * 1024);
						}
					} else if (msg.type === "logEnd") {
						// Stream finished (process exited/stopped): the log
						// view can annotate the end instead of looking stuck.
						self.streamEnded = self.streamEnded || {};
						self.streamEnded[msg.projectKey] = msg.status || "ended";
					} else if (msg.type === "logSnapshot") {
							self.logs[msg.projectKey] = msg.text || "";
					} else if (msg.type === "status") {
						// Create-or-update: a start broadcast may arrive for a
						// service this page has never seen. A terminal status
						// (non-running) also resolves a pending "stopping"
						// spinner; ANY status resolves a pending "starting".
						var prev = self.services[msg.projectKey] || {};
						// Uptime bookkeeping: the WS status message carries no
						// uptimeMs, so keep a LOCAL startedAt. On transition
						// INTO running, anchor it (preserving the snapshot's
						// accumulated uptime if we have one); the tick loop
						// below derives live uptime from it.
						var wasRunning = prev.running === true;
						var startedAt = prev.startedAt;
						if (msg.status === "running" && !wasRunning) {
							startedAt = Date.now() - (prev.uptimeMs || 0);
						} else if (msg.status !== "running") {
							startedAt = undefined;
						}
						self.services[msg.projectKey] = Object.assign({}, prev, {
							projectKey: msg.projectKey,
							projectDir: msg.projectDir || prev.projectDir,
							running: msg.status === "running",
							status: msg.status,
							port: msg.port,
							mode: msg.mode,
							startedAt: startedAt,
						});
						if (self.busyKeys[msg.projectKey]) {
							var busyPhase = self.busyKeys[msg.projectKey];
							var resolved = busyPhase === "starting"
								? true
								: busyPhase === "stopping" && msg.status !== "running";
							if (resolved) delete self.busyKeys[msg.projectKey];
						}
					}
						self.emit();
					};
					ws.onclose = function () {
						self.ws = null;
						self.connected = false;
						self.emit();
						self.scheduleReconnect();
					};
					ws.onerror = function () {
						try { ws.close(); } catch (e) { /* onclose follows */ }
					};
				}).catch(function (error) {
					self.connecting = false;
					self.connected = false;
					self.lastError = error.message || "DSH 控制通道连接失败";
					self.emit();
					self.scheduleReconnect();
				});
			},
			scheduleReconnect: function () {
				var self = this;
				if (this.reconnectTimer) return;
				this.reconnectTimer = setTimeout(function () {
					self.reconnectTimer = null;
					self.connect();
				}, RECONNECT_MS);
			},

			// Open the full-screen panel (entry button) — auto-discover
			// workspace projects on every open.
			openPanel: function () {
				this.panelOpen = true;
				this.emit();
				this.discover();
			},
			closePanel: function () { this.panelOpen = false; this.emit(); },

			// Pull the launch profile for a dir (profiles list, port, mode...)
			inspectDir: function (dir) {
				var self = this;
				self.inspect = null;
				self.inspectTargetDir = dir;
				self.emit();
				return controlFetch("/inspect?dir=" + encodeURIComponent(dir))
					.then(function (r) { return r.json(); })
					.then(function (j) {
						// ignore stale responses (user typed another dir meanwhile)
						if (self.inspectTargetDir !== dir) return null;
						self.inspect = j;
						self.emit();
						return j;
					})
					.catch(function (e) {
						if (self.inspectTargetDir === dir) {
							self.inspect = { matched: false, why: String(e.message || e) };
							self.emit();
						}
						return null;
					});
			},

			startService: function (opts) {
				if (!this.port) return Promise.reject(new Error("not connected"));
				rememberDir(opts.dir);
				if (opts.profile) rememberProfile(opts.dir, opts.profile);
				// busyKeys always keyed by the REAL projectKey when the entry
				// is known; unknown dirs use a pending key that the fetch
				// response re-keys immediately (WS broadcasts only know real
				// keys — a lingering pending key can never resolve and the
				// row stays stuck on 启动中, observed live).
				var existing = Object.keys(this.services).find((function (k) {
					var b = this.services[k];
					return b.projectDir && b.projectDir.toLowerCase() === String(opts.dir).toLowerCase();
				}).bind(this));
				var busyKey = existing || "pending-" + opts.dir;
				this.busyKeys[busyKey] = "starting";
				this.emit();
				var self = this;
				var clearBusy = function (k) {
					if (self.busyKeys[k] === "starting") {
						delete self.busyKeys[k];
						self.emit();
					}
				};
				// Safety net: 45s (slow reactor prepares can exceed 30s).
				setTimeout(function () { clearBusy(busyKey); }, 45000);
				var body = Object.assign({ detach: true }, opts);
				return controlFetch("/start", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(body),
				}).then(function (r) { return r.json(); }).then(function (res) {
					if (res && res.isError) store.lastError = (res.error && res.error.message) || "start failed";
					else store.lastError = null;
					// /start 成功响应是一次完整、权威的启动结果。WS 的 running
					// 广播可能早于 HTTP 响应到达，且广播不携带 projectDir；若只
					// 等 WS，工作区卡片无法按目录关联运行项，按钮会退回 Start。
					// 在这里用原请求目录补齐注册表，同时结束 starting 状态。
					if (res && !res.isError && res.projectKey) {
						var prev = self.services[res.projectKey] || {};
						var isRunning = res.status === "running";
						self.services[res.projectKey] = Object.assign({}, prev, res, {
							projectKey: res.projectKey,
							projectDir: opts.dir,
							running: isRunning,
							startedAt: isRunning
								? (prev.startedAt || Date.now() - (res.uptimeMs || 0))
								: undefined,
						});
						delete self.busyKeys[busyKey];
						delete self.busyKeys[res.projectKey];
					}
					// 失败响应没有可登记的运行项，只需解除原 pending 状态；
					// 成功分支已由上面的权威响应完成状态收敛。
					if (res && res.isError && busyKey !== res.projectKey) {
						clearBusy(busyKey);
					}
					store.emit();
					return res;
				}).catch(function (e) {
					clearBusy(busyKey);
					store.lastError = String(e.message || e);
					store.emit();
					throw e;
				});
			},
			stopService: function (projectKey) {
				if (!this.port) return Promise.reject(new Error("not connected"));
				this.busyKeys[projectKey] = "stopping";
				this.emit();
				var self = this;
				// Graceful stop can take up to ~10s (engine waits for shutdown
				// hooks); the WS status resolves the spinner, this is the net.
				setTimeout(function () { if (self.busyKeys[projectKey] === "stopping") { delete self.busyKeys[projectKey]; self.emit(); } }, 20000);
				return controlFetch("/stop", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ key: projectKey }),
				}).then(function (r) { return r.json(); }).then(function (res) {
					// /stop resolves synchronously (the engine awaited the
					// kill before responding) — clear the spinner now unless
					// the process is somehow still running.
					if (self.busyKeys[projectKey]) {
						var stillRunning = self.services[projectKey] && self.services[projectKey].running;
						if (!stillRunning) delete self.busyKeys[projectKey];
					}
					store.emit();
					return res;
				});
			},
		};

		store.connect();

		// Live-uptime tick: derived uptime (Date.now() - startedAt) only moves
		// when React re-renders, so nudge listeners every second while any
		// service is running. Cheap and stops mattering when nothing runs.
		setInterval(function () {
			var anyRunning = Object.keys(store.services).some(function (k) {
				return store.services[k].running;
			});
			if (anyRunning) store.emit();
		}, 1000);

		function useStore() {
			var forceUpdate = useState(0)[1];
			useEffect(function () {
				return store.subscribe(function () { forceUpdate(function (n) { return n + 1; }); });
			}, []);
			return store;
		}

		// Strip ANSI escapes for display (logback %red/%highlight leave raw
		// \x1b[..m sequences in the stream; the log FILE strips them but the
		// wire doesn't).
		// ─── Design system (injected once for the Spring Boot services panel) ──
		var STYLE_ID = "dsh-spring-boot-launcher-style";
		var cssInjected = false;
		function injectStyles() {
			if (cssInjected || document.getElementById(STYLE_ID)) return;
			var style = document.createElement("style");
			style.id = STYLE_ID;
			style.textContent = [
				// Theme-adaptive variables: the panel FOLLOWS the DSH theme via
				// its --dsw-alias-* semantic tokens (auto-switch with light/dark).
				// Neutral colors map to theme layers; STATE colors map to the
				// theme's state tokens (error/success/warn) and brand accent —
				// with a dark-mode hint layer for the chips' glow on dark
				// backgrounds.
				// 遮罩使用半透明底色，保留主界面上下文；不能混合两个不透明表面色。
				// 仅模糊面板背后的内容，面板自身仍保持清晰。
				".blv3-overlay{position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.25);backdrop-filter:blur(4px);-webkit-backdrop-filter:blur(4px);display:flex;align-items:center;justify-content:center;pointer-events:auto;font-family:var(--sans);color:var(--text-1)}"
				+ ".blv3-overlay{--bg-app:var(--dsw-alias-bg-base,#12151c);--bg-panel:var(--dsw-alias-bg-layer-1,#171b23);--bg-card:var(--dsw-alias-bg-layer-2,#1d222c);--bg-inset:var(--dsw-alias-bg-base,#141821);--bg-hover:color-mix(in srgb,var(--dsw-alias-bg-layer-2,#1d222c) 82%, var(--dsw-alias-brand-primary,#6ca4e0));--line:var(--dsw-alias-border-l2,#2a3140);--line-soft:var(--dsw-alias-border-l1,#232936);--text-1:var(--dsw-alias-label-primary,#e8ecf3);--text-2:var(--dsw-alias-label-secondary,#9aa5b5);--text-3:color-mix(in srgb,var(--dsw-alias-label-secondary,#9aa5b5) 55%, transparent);--ok:var(--dsw-alias-state-success-primary,#34d399);--ok-dim:color-mix(in srgb,var(--dsw-alias-state-success-primary,#34d399) 12%,transparent);--warn:var(--dsw-alias-state-warn-primary,#fbbf24);--warn-dim:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#fbbf24) 12%,transparent);--err:var(--dsw-alias-state-error-primary,#f87171);--err-dim:color-mix(in srgb,var(--dsw-alias-state-error-primary,#f87171) 12%,transparent);--idle:var(--dsw-alias-label-secondary,#64748b);--idle-dim:color-mix(in srgb,var(--dsw-alias-label-secondary,#64748b) 14%,transparent);--accent:var(--dsw-alias-brand-primary,#6ca4e0);--accent-hi:color-mix(in srgb,var(--dsw-alias-brand-primary,#6ca4e0) 80%,#fff);--r-sm:6px;--r-md:10px;--r-lg:14px;--mono:var(--ds-font-family-code,'JetBrains Mono',Consolas,monospace);--sans:var(--dsw-font-family,'Segoe UI',system-ui,sans-serif)}",
				".blv3-panel{width:min(1280px,92vw);height:88vh;min-height:640px;background:var(--bg-panel);border:1px solid var(--line);border-radius:var(--r-lg);box-shadow:0 24px 64px rgba(0,0,0,.5),0 0 0 1px rgba(255,255,255,.02) inset;display:flex;flex-direction:column;overflow:hidden}",
				".blv3-head{display:flex;align-items:center;gap:16px;padding:14px 20px;border-bottom:1px solid var(--line);background:linear-gradient(180deg,var(--bg-card),var(--bg-panel))}",
				".blv3-title{display:flex;align-items:baseline;gap:10px}.blv3-title h1{font-size:17px;font-weight:650;letter-spacing:.2px;margin:0}.blv3-title .sub{font-size:12px;color:var(--text-3)}",
				".blv3-summary{display:flex;gap:8px;margin-left:8px}",
				".blv3-chip{display:inline-flex;align-items:center;gap:6px;font-size:11.5px;font-weight:550;padding:3px 10px;border-radius:999px;border:1px solid var(--line);background:var(--bg-card);color:var(--text-2);font-variant-numeric:tabular-nums}",
				".blv3-chip .dot{width:7px;height:7px;border-radius:50%;background:var(--idle)}",
				".blv3-chip.ok{color:var(--ok);border-color:color-mix(in srgb,var(--ok) 30%,transparent);background:var(--ok-dim)}.blv3-chip.ok .dot{background:var(--ok);box-shadow:0 0 6px var(--ok)}",
				".blv3-chip.err{color:var(--err);border-color:color-mix(in srgb,var(--err) 30%,transparent);background:var(--err-dim)}.blv3-chip.err .dot{background:var(--err)}",
				".blv3-headright{margin-left:auto;display:flex;align-items:center;gap:10px}",
				".blv3-conn{display:flex;align-items:center;gap:6px;font-size:11px;color:var(--text-3);font-family:var(--mono)}",
				".blv3-conn .dot{width:7px;height:7px;border-radius:50%;background:var(--ok);box-shadow:0 0 6px var(--ok);animation:blv3-breathe 3s ease-in-out infinite}",
				".blv3-conn.off .dot{background:var(--err)}",
				"@keyframes blv3-breathe{50%{opacity:.45}}",
				".blv3-btn{font-family:var(--sans);font-size:12px;font-weight:600;padding:5px 16px;border-radius:var(--r-sm);border:1px solid transparent;cursor:pointer;transition:background .12s,transform .06s,border-color .12s;letter-spacing:.2px}",
				".blv3-btn:active{transform:translateY(1px)}",
				".blv3-btn.ghost{background:var(--bg-card);color:var(--text-2);border-color:var(--line)}",
				".blv3-btn.ghost:hover{background:var(--bg-hover);color:var(--text-1)}",
				".blv3-projects{border-bottom:1px solid var(--line)}",
				".blv3-projhead{display:flex;align-items:center;gap:10px;padding:9px 20px;font-size:11px;color:var(--text-3);letter-spacing:.6px;text-transform:uppercase;font-weight:600}",
				".blv3-projhead .meta{color:var(--text-2);letter-spacing:0;text-transform:none;font-weight:400}",
				".blv3-projhead .spacer{flex:1}",
				".blv3-filters{display:flex;gap:4px}",
				".blv3-filter{font-size:10.5px;font-weight:550;padding:2px 10px;border-radius:999px;cursor:pointer;border:1px solid transparent;background:transparent;color:var(--text-3);transition:color .1s,background .1s}",
				".blv3-filter:hover{color:var(--text-2);background:var(--bg-card)}",
				".blv3-filter.active{color:var(--text-1);background:var(--bg-card);border-color:var(--line)}",
				".blv3-filter .n{font-family:var(--mono);color:var(--text-2);margin-left:3px}",
				".blv3-projlist{max-height:292px;overflow-y:auto;padding:0 12px 12px;display:grid;grid-template-columns:1fr 1fr;gap:8px}",
				".blv3-card{position:relative;display:flex;align-items:center;gap:10px;padding:9px 12px 9px 16px;background:var(--bg-card);border:1px solid var(--line-soft);border-radius:var(--r-md);cursor:pointer;transition:background .12s,border-color .12s;overflow:hidden}",
				".blv3-card:hover{background:var(--bg-hover);border-color:var(--line)}",
				".blv3-card.selected{border-color:color-mix(in srgb,var(--accent) 55%,transparent);background:color-mix(in srgb,var(--bg-card) 86%,var(--accent))}",
				".blv3-card::before{content:'';position:absolute;left:0;top:0;bottom:0;width:3px;background:var(--idle);opacity:.85}",
				".blv3-card.running::before{background:var(--ok)}",
				".blv3-card.error::before{background:var(--err)}",
				".blv3-pmain{flex:1;min-width:0}",
				".blv3-pname{font-size:12.5px;font-weight:600;color:var(--text-1);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
				".blv3-pname .modulepath{color:var(--text-3);font-weight:400}",
				".blv3-psub{display:flex;align-items:center;gap:8px;margin-top:2px;font-size:10.5px;color:var(--text-3);font-family:var(--mono)}",
				".blv3-psub .port{color:var(--ok)}",
				".blv3-psub .upt{color:var(--text-2)}",
				".blv3-pactions{display:flex;align-items:center;gap:6px;flex-shrink:0}",
				// color-scheme:dark makes the NATIVE dropdown popup (OS-drawn,
				// not styled by page CSS) dark with light text — without it the
				// options list renders as an unreadable white box or empty.
				".blv3-panel,.blv3-selprofile,.blv3-search{color-scheme:dark}",
				".blv3-selprofile{font-family:var(--mono);font-size:10.5px;padding:4px 6px;border-radius:var(--r-sm);background:var(--bg-inset);color:var(--text-2);border:1px solid var(--line);cursor:pointer;max-width:96px}",
				".blv3-mini{font-size:11px;font-weight:650;padding:4px 14px;border-radius:var(--r-sm);border:1px solid transparent;cursor:pointer;transition:background .12s,transform .06s}",
				".blv3-mini:active{transform:translateY(1px)}",
				// Start button ink: NOT brand-primary-invert (that token equals
				// brand in the DARK theme — near-white on near-white, observed
				// as invisible buttons). The safe contrast pair is brand bg +
				// the theme's BASE bg as ink: dark theme = white bg + dark ink,
				// light theme = near-black bg + light ink. Complementary by
				// construction because DSH's brand flips with the theme.
				".blv3-mini.start{background:var(--dsw-alias-brand-primary,var(--accent));color:var(--bg-app,#0e1420)}",
				".blv3-mini.start:hover{background:color-mix(in srgb,var(--dsw-alias-brand-primary,var(--accent)) 86%,var(--bg-app,#fff))}",
				".blv3-mini.stop{background:transparent;color:var(--err);border-color:color-mix(in srgb,var(--err) 45%,transparent)}",
				".blv3-mini.stop:hover{background:var(--err-dim)}",
				".blv3-mini.busy{background:var(--idle);color:var(--text-1);cursor:wait;opacity:.85}",
				".blv3-body{flex:1;display:flex;min-height:0;position:relative}",
				".blv3-services{width:264px;flex-shrink:0;border-right:1px solid var(--line);display:flex;flex-direction:column;min-height:0;background:color-mix(in srgb,var(--bg-panel) 86%,var(--bg-app))}",
				".blv3-colhead{padding:9px 14px;font-size:11px;color:var(--text-3);letter-spacing:.6px;text-transform:uppercase;font-weight:600;border-bottom:1px solid var(--line-soft);display:flex;align-items:center;gap:8px}",
				".blv3-colhead .spacer{flex:1}",
				// Collapse controls must LOOK interactive: a bordered pill with
				// icon + text + hover feedback, not a bare ▾ glyph nobody notices.
				".blv3-collapse{display:inline-flex;align-items:center;gap:4px;background:var(--bg-card);color:var(--text-2);border:1px solid var(--line);border-radius:999px;font-size:10px;font-weight:600;padding:2px 10px;cursor:pointer;transition:background .12s,color .12s,border-color .12s;user-select:none;font-family:var(--sans)}",
				".blv3-collapse:hover{background:var(--bg-hover);color:var(--text-1);border-color:var(--line)}",
				".blv3-collapse .chev{font-size:11px;line-height:1;color:var(--accent)}",
				".blv3-svclist{flex:1;overflow-y:auto;padding:8px;display:flex;flex-direction:column;gap:6px}",
				".blv3-svcrow{display:flex;align-items:center;gap:9px;padding:8px 10px;border-radius:var(--r-md);cursor:pointer;border:1px solid transparent;transition:background .1s}",
				".blv3-svcrow:hover{background:var(--bg-hover)}",
				".blv3-svcrow.selected{background:color-mix(in srgb,var(--bg-card) 84%,var(--accent));border-color:color-mix(in srgb,var(--accent) 40%,transparent)}",
				".blv3-svcdot{width:8px;height:8px;border-radius:50%;flex-shrink:0}",
				".blv3-svcdot.running{background:var(--ok);box-shadow:0 0 6px var(--ok)}",
				".blv3-svcdot.stopped{background:none;border:1.5px solid var(--idle)}",
				".blv3-svcdot.error{background:var(--err)}",
				".blv3-svcmain{flex:1;min-width:0}",
				".blv3-svcname{font-size:12px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
				".blv3-svcmeta{font-size:10px;color:var(--text-3);font-family:var(--mono);margin-top:1px}",
				".blv3-logs{flex:1;display:flex;flex-direction:column;min-width:0}",
				".blv3-logtoolbar{display:flex;align-items:center;gap:10px;padding:8px 14px;border-bottom:1px solid var(--line-soft)}",
				".blv3-logtitle{display:flex;align-items:center;gap:8px;min-width:0;flex:1}",
				".blv3-logtitle .name{font-size:12.5px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
				".blv3-livepill{display:inline-flex;align-items:center;gap:5px;font-size:10px;font-weight:650;letter-spacing:.4px;padding:2px 9px;border-radius:999px;flex-shrink:0}",
				".blv3-livepill.on{color:var(--ok);background:var(--ok-dim);border:1px solid color-mix(in srgb,var(--ok) 30%,transparent)}",
				".blv3-livepill.off{color:var(--text-3);background:var(--idle-dim);border:1px solid var(--line)}",
				".blv3-livepill .dot{width:6px;height:6px;border-radius:50%;background:currentColor;animation:blv3-breathe 1.6s infinite}",
				".blv3-logpath{font-family:var(--mono);font-size:10px;color:var(--text-3);flex-shrink:0}",
				".blv3-searchbox{display:flex;align-items:center;gap:6px;flex-shrink:0}",
				".blv3-search{font-family:var(--mono);font-size:11px;width:150px;padding:4px 9px;background:var(--bg-inset);color:var(--text-1);border:1px solid var(--line);border-radius:var(--r-sm);outline:none;transition:border-color .12s,width .15s}",
				".blv3-search:focus{border-color:var(--accent);width:190px}",
				".blv3-search::placeholder{color:var(--text-3)}",
				".blv3-matchnav{display:flex;align-items:center;gap:3px;font-family:var(--mono);font-size:10.5px;color:var(--text-2)}",
				".blv3-navbtn{background:var(--bg-card);color:var(--text-2);border:1px solid var(--line);border-radius:4px;font-size:10px;padding:2px 7px;cursor:pointer}",
				".blv3-navbtn:hover{color:var(--text-1);background:var(--bg-hover)}",
				".blv3-logview{flex:1;overflow-y:auto;background:var(--bg-inset);padding:12px 16px;font-family:var(--mono);font-size:11.5px;line-height:1.65;white-space:pre-wrap;word-break:break-all;margin:0}",
				".blv3-logview .lv-ts{color:color-mix(in srgb,var(--text-2) 55%,transparent)}",
				".blv3-logview .lv-info{color:color-mix(in srgb,var(--text-2) 70%,var(--accent));font-weight:600}",
				".blv3-logview .lv-warn{color:var(--warn);font-weight:600}",
				".blv3-logview .lv-error{color:var(--err);font-weight:600}",
				".blv3-logview .lv-thread{color:var(--text-2)}",
				".blv3-logview .lv-pkg{color:color-mix(in srgb,var(--text-2) 80%,var(--accent))}",
				".blv3-logview .lv-msg{color:var(--text-1)}",
				".blv3-logview .lv-errline{color:color-mix(in srgb,var(--err) 80%,var(--text-1))}",
				".blv3-logview .lv-end{margin-top:10px;padding-top:8px;border-top:1px dashed var(--line);color:var(--text-3);font-size:10.5px;display:block}",
				".blv3-logview mark{background:#ebcb8b;color:#111;border-radius:2px;padding:0 2px;font-weight:bold}",
				".blv3-logview mark.cur{background:#d08770}",
				".blv3-logview .blv3-hit{display:inline-block;width:100%}",
				".blv3-logview .blv3-hit.cur{background:color-mix(in srgb,var(--bg-card) 80%,var(--accent));border-radius:4px;box-shadow:inset 3px 0 0 var(--accent)}",
				".blv3-statusbar{display:flex;align-items:center;gap:14px;padding:5px 16px;border-top:1px solid var(--line-soft);background:var(--bg-inset);font-family:var(--mono);font-size:10px;color:var(--text-3);font-variant-numeric:tabular-nums}",
				".blv3-adv{padding:4px 20px 10px}",
				".blv3-advtoggle{cursor:pointer;color:var(--text-3);font-size:10.5px;user-select:none}",
				".blv3-advtoggle:hover{color:var(--text-2)}",
				".blv3-advrow{display:flex;gap:6px;margin-top:6px;align-items:center}",
				".blv3-advrow input{font-family:var(--mono);font-size:11px;flex:1;min-width:0;padding:4px 9px;background:var(--bg-inset);color:var(--text-1);border:1px solid var(--line);border-radius:var(--r-sm);outline:none}",
				".blv3-advrow input:focus{border-color:var(--accent)}",
				".blv3-recentselect{max-width:220px;min-width:135px}",
				".blv3-clearrecent{flex:none;border:0;background:transparent;color:var(--text-3);font-size:10px;padding:3px 2px;cursor:pointer}",
				".blv3-clearrecent:hover{color:var(--err)}",
				".blv3-errorline{color:var(--err);font-size:10px;padding:6px 20px;word-break:break-all}",
			].join("\n");
			document.head.appendChild(style);
			cssInjected = true;
		}
		// The engine writes the log FILE with ANSI stripped, but the wire
		// keeps the original sequences — logback %red/%highlight colors are
		// standard SGR codes, so we can restore them in the GUI instead of
		// rendering everything white-on-black. Escapes user text first
		// (logs are untrusted input), then maps SGR codes to spans.
		var SGR_COLORS = {
			30: "#4c566a", 31: "#bf616a", 32: "#a3be8c", 33: "#ebcb8b",
			34: "#81a1c1", 35: "#b48ead", 36: "#88c0d0", 37: "#d8dee9",
			90: "#616e88", 91: "#d08770", 92: "#a3be8c", 93: "#ebcb8b",
			94: "#88c0d0", 95: "#c8b8f0", 96: "#8fbcbb", 97: "#eceff4",
		};
		function escapeHtml(s) {
			return String(s)
				.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
				.replace(/"/g, "&quot;");
		}
		function ansiToHtml(raw) {
			var esc = escapeHtml(raw);
			var out = "";
			var pos = 0;
			var openSpans = 0;
			var bold = false;
			var re = /\x1b\[([0-9;]*)m/g;
			var last = 0;
			var m;
			while ((m = re.exec(esc)) !== null) {
				out += esc.slice(last, m.index);
				var codes = m[1] === "" ? ["0"] : m[1].split(";");
				for (var ci = 0; ci < codes.length; ci++) {
					var c = codes[ci];
					if (c === "0") {
						// reset: close any open color spans
						while (openSpans > 0) { out += "</span>"; openSpans--; }
						bold = false;
					} else if (c === "1") {
						bold = true;
					} else if (c === "22") {
						bold = false;
					} else if (SGR_COLORS[c]) {
						// bold+color combos (logback %highlight emits "1;31")
						// render as ONE span; no pre-closing needed.
						out += '<span style="color:' + SGR_COLORS[c] + (bold ? ";font-weight:bold" : "") + '">';
						openSpans++;
					}
				}
				last = re.lastIndex;
			}
			out += esc.slice(last);
			while (openSpans > 0) { out += "</span>"; openSpans--; }
			return out;
		}

			// Structured log coloring (v3 prototype): parse PLAIN log lines into
			// ts / [thread] LEVEL / pkg / message segments and color each. Only
			// applies to lines WITHOUT ANSI (ANSI lines already carry colors);
			// both paths are HTML-escaped first.
			// Matches both "2026-09-02 09:35:53,148" and "09:35:53.148" styles,
			// Spring Boot's "[thread] LEVEL pkg - msg" and logback "pkg - msg".
			var LOG_TS_RE = /^((?:\d{4}-\d{2}-\d{2}[ T])?\d{2}:\d{2}:\d{2}[.,]\d{3})/;
			function structureLog(line) {
				if (/\x1b\[/.test(line)) return ansiToHtml(line); // colored already
				var esc = escapeHtml(line);
				var m = esc.match(LOG_TS_RE);
				var ts = m ? m[1] : "";
				var rest = ts ? esc.slice(ts.length) : esc;
				// level + thread: " [main] INFO  pkg - msg" or "INFO [main]"
				var lm = rest.match(/^\s*\[([^\]]+)\]\s+(TRACE|DEBUG|INFO|WARN|ERROR|FATAL)\s*/);
				var thread = "", level = "", after = rest;
				if (lm) { thread = lm[1]; level = lm[2]; after = rest.slice(lm[0].length); }
				else {
					var lm2 = rest.match(/^\s*(TRACE|DEBUG|INFO|WARN|ERROR|FATAL)\s+\[([^\]]+)\]\s*/);
					if (lm2) { level = lm2[1]; thread = lm2[2]; after = rest.slice(lm2[0].length); }
				}
				var out = "";
				if (ts) out += '<span class="lv-ts">' + ts + "</span>";
				if (thread) out += ' [<span class="lv-thread">' + thread + "</span>] ";
				if (level) {
					var lvCls = level === "ERROR" || level === "FATAL" ? "lv-error" : level === "WARN" ? "lv-warn" : "lv-info";
					out += '<span class="' + lvCls + '">' + level + "</span> ";
				}
				// package/class name then message: "o.a.catalina.core.X - msg"
				var pm = after.match(/^([\w.$]+(?:\$\$[\w$]+)?)\s*-\s*([\s\S]*)$/);
				if (pm) {
					out += '<span class="lv-pkg">' + pm[1] + "</span> - ";
					var msg = pm[2];
					out += /ERROR|Exception|FAILED/i.test(level + " " + msg.slice(0, 60))
						? '<span class="lv-errline">' + msg + "</span>"
						: '<span class="lv-msg">' + msg + "</span>";
				} else {
					out += level ? '<span class="lv-msg">' + after + "</span>" : after;
				}
				return out;
			}

			function fmtUptime(ms) {
			var s = Math.floor(ms / 1000);
			if (s < 60) return s + "s";
			var m = Math.floor(s / 60);
			if (m < 60) return m + "m" + (s % 60) + "s";
			return Math.floor(m / 60) + "h" + (m % 60) + "m";
		}

		// ─── Sidebar entry (footer.action) ─────────────────────────────
		// One row: status dot + label + count of running services. Click
		// opens the management panel; the list itself lives in the panel now.
		function SpringBootServicesEntry() {
			var s = useStore();
			var running = Object.keys(s.services).filter(function (k) {
				return s.services[k].running;
			}).length;
			var color = !s.connected ? "var(--dsw-alias-state-warn-primary,#d08770)"
				: running > 0 ? "var(--dsw-alias-state-success-primary,#a3be8c)"
					: "var(--dsw-alias-label-secondary,#616e88)";
			return createElement("div", {
				onClick: function () { s.openPanel(); },
				style: {
					display: "flex", alignItems: "center", gap: "6px",
					padding: "6px 8px", cursor: "pointer",
					borderRadius: "4px", fontSize: "11px",
					color: "var(--dsw-alias-label-primary,#d8dee9)",
				},
				title: s.connected
					? "Spring Boot services — " + running + " running (click to manage)"
					: (s.lastError || "connecting…"),
			},
				createElement("span", { style: { color: color, fontSize: "13px" } }, "●"),
				createElement("span", null, "Spring Boot"),
				running > 0
					? createElement("span", {
						style: {
							background: "var(--dsw-alias-state-success-primary,#a3be8c)",
							color: "var(--dsw-alias-bg-base,#2e3440)", borderRadius: "8px",
							padding: "0 6px", fontSize: "10px", fontWeight: "bold",
						},
					}, String(running))
					: null
			);
		}

		// ─── Project list (workspace-scan driven) ────────────────────────
		// Opening the panel triggers a workspace scan; every found Spring Boot
		// project renders as a LIST ROW with its own profile picker and
		// Start/Stop action (running state merged from the registry). A
		// refresh button re-scans — that covers "I added a workspace later".
		function ProjectGrid() {
			var s = useStore();
			var cards = s.discovered;
			var settings = loadSettings();
			var [collapsed, setCollapsed] = useState(false);
			// status filter (v3 chips): all / running / stopped / error
			var [filter, setFilter] = useState("all");

			// Merge registry state: a discovered project that is running
			// shows its live status + Stop instead of Start.
			function serviceOf(dir) {
				var keys = Object.keys(s.services);
				for (var i = 0; i < keys.length; i++) {
					var b = s.services[keys[i]];
					if (b.projectDir && b.projectDir.toLowerCase() === String(dir).toLowerCase()) return b;
				}
				return null;
			}

			// apply the status filter to the discovered cards
			var filteredCards = cards.filter(function (c) {
				if (filter === "all") return true;
				var b = serviceOf(c.dir);
				if (filter === "running") return b && b.running;
				if (filter === "stopped") return !b || !b.running;
				if (filter === "error") return b && !b.running && b.status !== "completed" && b.status !== "killed";
				return true;
			});

			return createElement("div", { className: "blv3-projects" },
				// head: section title + meta + status filter chips + an EXPLICIT
				// collapse pill. The bare ▾/▸ glyph was invisible to users —
				// the pill (bordered, accent chev, 收起/展开 text, hover) is
				// the visible affordance; the title stays clickable too.
				createElement("div", { className: "blv3-projhead" },
					createElement("span", {
						style: { cursor: "pointer", userSelect: "none" },
						onClick: function () { setCollapsed(!collapsed); },
						title: collapsed ? "展开项目列表" : "收起项目列表（日志区更大）",
					}, (collapsed ? "▸" : "▾") + " 工作区项目"),
					createElement("span", { className: "meta" },
						s.discovering ? "扫描中…" :
							cards.length > 0 ? "点击卡片选择 · 下拉切 profile · 行内一键启停" :
								"未发现 Spring Boot 项目 — 可展开下方手动输入或点重新扫描"),
					createElement("span", { className: "spacer" }),
					createElement("button", {
						className: "blv3-collapse",
						onClick: function () { setCollapsed(!collapsed); },
						title: collapsed ? "展开项目列表" : "收起项目列表（日志区更大）",
					},
						createElement("span", { className: "chev" }, collapsed ? "▸" : "▾"),
						collapsed ? "展开" : "收起"),
					createElement("div", { className: "blv3-filters" },
						["all", "running", "stopped", "error"].map(function (f) {
							var n = f === "all" ? cards.length
								: f === "running" ? cards.filter(function (c) { var b = serviceOf(c.dir); return b && b.running; }).length
									: f === "error" ? cards.filter(function (c) { var b = serviceOf(c.dir); return b && !b.running && b.status !== "completed" && b.status !== "killed"; }).length
										: cards.filter(function (c) { var b = serviceOf(c.dir); return !b || !b.running; }).length;
							var label = f === "all" ? "全部" : f === "running" ? "运行中" : f === "stopped" ? "已停止" : "异常";
							var active = filter === f;
							return createElement("span", {
								key: f,
								className: "blv3-filter" + (active ? " active" : ""),
								onClick: function () { setFilter(f); },
							}, label, createElement("span", { className: "n", style: f === "running" ? { color: "var(--ok)" } : f === "error" ? { color: "var(--err)" } : null }, String(n)));
						}))),
				// cards — two-column grid, clamped height, status-rail cards
				!collapsed && filteredCards.length > 0
					? createElement("div", { className: "blv3-projlist" },
						filteredCards.map(function (c) {
							return createElement(ProjectRow, { key: c.dir, proj: c, service: serviceOf(c.dir), settings: settings });
						}))
					: null,
				);
		}

		// One discovered project row: name + profile select + Start/Stop.
		function ProjectRow(props) {
			var s = useStore();
			var proj = props.proj;
			var service = props.service;   // registry entry when running/recently stopped
			var settings = props.settings;
			var busyRef = useRef(false);
			var selected = s.selectedProject === proj.dir;

			// Profiles prefer the discover payload (new host: ready on first
			// paint); fall back to the per-row inspect while an older host's
			// /discover returns rows without profiles.
			var profiles = proj.profiles && proj.profiles.length > 0
				? proj.profiles
				: (selected && s.projectInspect && s.projectInspect.profiles) || [];
			var defProf = (settings.defaultProfile || {})[proj.dir] || null;
			var chosen = defProf || proj.activeProfile ||
				(selected && s.projectInspect && s.projectInspect.activeProfile) || "";
			var running = service && service.running;
			// busy phase for the action button (between click and WS confirm)
			var bkey = service ? service.projectKey : "pending-" + proj.dir;
			var busyPhase = s.busyKeys[bkey] || (busyRef.current ? "starting" : null);

				function startOrStop() {
					// resolve the projectKey for the busy spinner
					var bkey = service ? service.projectKey : "pending-" + proj.dir;
					if (s.busyKeys[bkey]) return; // already starting/stopping
					if (running) {
						s.stopService(service.projectKey).then(function () { s.emit(); }).catch(function () {});
						return;
					}
					if (busyRef.current) return;
					busyRef.current = true;
					rememberDir(proj.dir);
					if (chosen) rememberProfile(proj.dir, chosen);
				// Launch. If this row's profiles were never hydrated (old-host
				// fallback path), fetch them first so the user's remembered
				// default can apply on THIS start rather than the next.
				var go = function (profileToUse) {
					s.startService({ dir: proj.dir, profile: profileToUse || undefined })
						.then(function () { busyRef.current = false; s.emit(); })
						.catch(function (e) { busyRef.current = false; s.lastError = String(e.message || e); s.emit(); });
				};
				if (!chosen && proj.profiles === undefined && s.port) {
					controlFetch("/inspect?dir=" + encodeURIComponent(proj.dir))
						.then(function (r) { return r.json(); })
						.then(function (j) {
							if (j && j.profiles) {
								proj.profiles = j.profiles;
								proj.activeProfile = j.activeProfile;
							}
							var remembered = (loadSettings().defaultProfile || {})[proj.dir];
							go(remembered || (j && j.activeProfile));
						})
						.catch(function () { go(undefined); });
				} else {
					go(chosen || undefined);
				}
			}

			// v3 card classes: running/stopped/error drive the left rail.
			// TCP 连通只能证明配置端口被占用，不能证明运行的是这个项目。
			// 已停止的托管记录也不能掩盖其他进程的端口占用。
			var external = (!running && proj.externalPort) || null;
			var cardClass = "blv3-card" +
				(service && service.running ? " running" : "") +
				(service && !service.running && service.status !== "completed" && service.status !== "killed" ? " error" : "") +
				(selected ? " selected" : "");
			// split the module path from the leaf name (prototype style)
			var nameSplit = String(proj.name).split("/");
			var leafName = nameSplit.pop();
			var modulePath = nameSplit.length ? nameSplit.join("/") + "/" : "";
			// sub-line: running → port + uptime; stopped → last profile; error → reason
			var subEls = [];
			if (running && service) {
				if (service.port) subEls.push(createElement("span", { className: "port", key: "p" }, ":" + service.port));
				// Live uptime: prefer the local startedAt anchor (ticks every
				// second); the raw uptimeMs field is a stale snapshot value.
				var liveMs = service.startedAt ? Date.now() - service.startedAt : (service.uptimeMs || 0);
				subEls.push(createElement("span", { className: "upt", key: "u" }, "运行 " + fmtUptime(liveMs)));
				if (service.mode) subEls.push(createElement("span", { key: "m", title: service.mode }, service.mode.split(" ")[0]));
			} else if (service && service.status !== "completed" && service.status !== "killed") {
				subEls.push(createElement("span", { style: { color: "var(--err)" }, key: "e", title: "进程在健康检查前提前退出，点重试重新启动" }, "启动失败 · " + service.status));
			} else if (external) {
				subEls.push(createElement("span", { style: { color: "var(--warn)" }, key: "ep" }, ":" + external));
				subEls.push(createElement("span", {
					key: "ex",
					title: "项目配置中的端口被占用，进程归属尚未确认，不代表该服务正在运行。检测范围包含其他 profile；请核对端口配置，释放冲突后重新扫描。",
					style: { color: "var(--warn)" },
				}, "端口占用 · 归属未确认"));
			} else if (service) {
				subEls.push(createElement("span", { key: "l" }, "上次 · " + (chosen || service.mode || "-")));
			} else {
				if (chosen) subEls.push(createElement("span", { key: "c" }, chosen));
			}

			return createElement("div", {
				className: cardClass,
				onClick: function () {
					s.selectProject(proj.dir);
					var bkeys = Object.keys(s.services);
					for (var i = 0; i < bkeys.length; i++) {
						var b = s.services[bkeys[i]];
						if (b.projectDir && b.projectDir.toLowerCase() === String(proj.dir).toLowerCase()) {
							s.selectedKey = b.projectKey;
						}
					}
					s.emit();
				},
			},
				createElement("div", { className: "blv3-pmain" },
					createElement("div", { className: "blv3-pname", title: proj.dir },
						modulePath ? createElement("span", { className: "modulepath" }, modulePath) : null,
						leafName),
					createElement("div", { className: "blv3-psub" }, subEls)),
				createElement("div", { className: "blv3-pactions" },
					// profile select (mono, inset)
					createElement("select", {
						className: "blv3-selprofile",
						value: chosen,
						disabled: profiles.length === 0 && !selected,
						onClick: function (e) {
							e.stopPropagation();
							if (profiles.length === 0) s.selectProject(proj.dir);
						},
						onChange: function (e) { e.stopPropagation(); rememberProfile(proj.dir, e.target.value); s.emit(); },
						title: profiles.length
							? "Spring profile（自动识别，选择会被记住）"
							: selected ? "正在读取项目 profile…" : "点击加载项目 profile",
					},
						profiles.length === 0
							? createElement("option", { value: chosen || "" }, chosen || "(默认)")
							: [""].concat(profiles).map(function (p) {
								return createElement("option", { key: p, value: p }, p === "" ? "(默认)" : p);
							})),
					// action: start solid / stop outline / busy slate (v3 mini).
					// 未确认进程身份时只提示端口风险，不能提供停止其他进程的操作。
					createElement("button", {
						className: "blv3-mini " + (busyPhase ? "busy" : running ? "stop" : "start"),
						onClick: function (e) { e.stopPropagation(); startOrStop(); },
						disabled: !s.connected || !!busyPhase || !!external,
						title: external
							? "配置端口 " + external + " 已被占用（进程归属未确认）。请核对当前 profile 的端口配置，处理冲突后重新扫描。"
							: busyPhase ? "等待状态确认…" : running ? "优雅停止（等待 shutdown 日志）" : "启动（IDEA 等价语义）",
					}, external
						? "端口占用"
						: busyPhase === "starting"
							? "⟳ 启动中…"
							: busyPhase === "stopping"
								? "⟳ 停止中…"
								: running ? "Stop"
									: (service && service.status !== "completed" && service.status !== "killed") ? "重试" : "Start")));
		}

		// ─── Advanced manual start (collapsed by default) ────────────────
		function AdvancedStart() {
			var s = useStore();
			var [show, setShow] = useState(false);
			var busyRef = useRef(false);
			var insp = s.inspect;
			var profiles = (insp && insp.profiles) || [];
			var settings = loadSettings();
			var recentDirs = (settings.recentDirs || []).slice(0, 8);
			var chosen = ((settings.defaultProfile || {})[s.inspectTargetDir || ""]) || (insp && insp.activeProfile) || profiles[0] || "";

			function chooseRecentDir(dir) {
				if (!dir) return;
				s.startDir = dir;
				// 最近路径属于手动启动流程，直接复用该流程的 inspect 状态，
				// 避免只更新 selectedProject 却没有任何组件展示结果。
				if (s.port) s.inspectDir(dir);
				else s.emit();
			}

			function onDirChange(e) {
				var dir = e.target.value.trim();
				s.startDir = dir;
				if (!dir) { s.inspect = null; s.inspectTargetDir = null; s.emit(); return; }
				if (s._inspectTimer) clearTimeout(s._inspectTimer);
				s._inspectTimer = setTimeout(function () { s.inspectDir(dir); }, 350);
			}
			function start() {
				var dir = s.startDir || "";
				if (!dir || busyRef.current) return;
				busyRef.current = true;
				s.startService({ dir: dir, profile: chosen || undefined })
					.then(function () { busyRef.current = false; s.emit(); })
					.catch(function (e) { busyRef.current = false; s.lastError = String(e.message || e); s.emit(); });
			}

		return createElement("div", { className: "blv3-adv" },
			createElement("div", {
				className: "blv3-advtoggle",
				onClick: function () { setShow(!show); },
			}, (show ? "▾ " : "▸ ") + "手动输入其他路径"),
			show
				? createElement("div", { className: "blv3-advrow" },
					createElement("input", {
						value: s.startDir || "",
						placeholder: "D:\\path\\to\\spring-boot\\project",
						onChange: onDirChange,
					}),
					recentDirs.length > 0
						? createElement("select", {
							className: "blv3-selprofile blv3-recentselect",
							value: "",
							"data-recent-paths": true,
							onChange: function (e) { chooseRecentDir(e.target.value); },
							title: "选择最近使用过、但当前工作区未扫描到的项目路径",
						},
							createElement("option", { value: "" }, "最近使用…"),
							recentDirs.map(function (dir) {
								var name = dir.split("\\").pop() || dir;
								return createElement("option", { key: dir, value: dir }, name + " — " + dir);
							}))
						: null,
					recentDirs.length > 0
						? createElement("button", {
							className: "blv3-clearrecent",
							onClick: function () { clearRecentDirs(); s.emit(); },
							title: "清空最近使用路径",
						}, "清空")
						: null,
					createElement("select", {
						className: "blv3-selprofile",
						value: chosen,
						disabled: profiles.length === 0,
						onChange: function (e) { rememberProfile(s.startDir || s.inspectTargetDir || "", e.target.value); s.emit(); },
						title: profiles.length ? "Spring profile（自动识别）" : "未发现 application-*.yml",
					},
						profiles.length === 0
							? createElement("option", { value: "" }, "(默认)")
							: [""].concat(profiles).map(function (p) {
								return createElement("option", { key: p, value: p }, p === "" ? "(默认)" : p);
							})),
					createElement("button", {
						className: "blv3-mini start",
						onClick: start,
						disabled: !s.connected || busyRef.current,
					}, busyRef.current ? "…" : "Start"))
				: null);
		}

		// ─── Service row in the management panel ───────────────────────
		function ServiceRow(props) {
			var s = useStore();
			var b = props.service;
			var selected = props.selected;
			var dotCls = b.running ? "running" : (b.status === "completed" || b.status === "killed") ? "stopped" : "error";
			// Live uptime from the local startedAt anchor (ticks every second);
			// the raw uptimeMs is a stale snapshot value.
			var liveMs = b.startedAt ? Date.now() - b.startedAt : (b.uptimeMs || 0);
			var meta = b.running
				? (b.port ? ":" + b.port + " · " : "") + fmtUptime(liveMs)
				: b.status === "completed" || b.status === "killed" ? "已停止" : b.status || "";
			return createElement("div", {
				className: "blv3-svcrow" + (selected ? " selected" : ""),
				onClick: function () { s.selectedKey = b.projectKey; s.emit(); },
			},
				createElement("span", { className: "blv3-svcdot " + dotCls }),
				createElement("div", { className: "blv3-svcmain" },
					createElement("div", { className: "blv3-svcname", title: b.projectDir || b.projectKey },
						(b.projectDir || b.projectKey).split("\\").pop() || b.projectKey),
					createElement("div", { className: "blv3-svcmeta" }, meta)));
		}

		// ─── Full-screen management panel (shell.overlay entry) ─────────
		// The overlay layer is click-through by design; our entry opts back
		// into pointer events ONLY while the panel is open, so a closed panel
		// never intercepts clicks meant for the app underneath.
		// Hooks rule: ALL hooks run unconditionally BEFORE the panelOpen
		// early-return — React #310 (hook count changed between renders)
		// crashes the slot entry otherwise.
		function SpringBootPanelHost() {
			var s = useStore();
			var logRef = useRef(null);
			var panelOpen = s.panelOpen;

			// Esc closes
			useEffect(function () {
				if (!panelOpen) return;
				var onKey = function (e) { if (e.key === "Escape") s.closePanel(); };
				window.addEventListener("keydown", onKey);
				return function () { window.removeEventListener("keydown", onKey); };
			}, [panelOpen]);

			var keys = panelOpen ? Object.keys(s.services) : [];
			var selKey = panelOpen && s.selectedKey && s.services[s.selectedKey]
				? s.selectedKey
				: (keys.filter(function (k) { return s.services[k].running; })[0] || keys[0] || null);
			var rawLog = selKey ? (s.logs[selKey] || "(no logs yet — waiting for output)") : "";
			// Terminal divider: once the stream has ended, append an explicit
			// end marker so the tail visibly stops instead of just going quiet.
			var logText = rawLog + (selKey && s.streamEnded[selKey]
				? "\n\n―――― 流已结束（" + s.streamEnded[selKey] + "）――――"
				: "");
			var sel = selKey ? s.services[selKey] : null;

			// Search/highlight: user keyword (kept in a ref-less store field so
			// it survives re-renders without losing input focus). Two layers:
			// matched LINES get a row background; each keyword OCCURRENCE gets
			// a yellow marker. Every matched line carries data-m=<index> so
			// prev/next can scroll to it.
			var [search, setSearch] = useState("");
			var [searchInput, setSearchInput] = useState("");
			var [matchIdx, setMatchIdx] = useState(0);
			var searchMatchCount = 0;
			var logHtml = "";
			(function buildLog() {
				var lines = String(logText).split("\n");
				var kw = search.trim();
				if (!kw) {
					logHtml = lines.map(function (l) { return structureLog(l); }).join("\n");
					return;
				}
				var k = kw.toLowerCase();
				// keyword escaped the same way the colorers escape text, so the
				// plain-text form inside colored HTML matches it exactly
				var kwEscaped = escapeHtml(kw);
				var rendered = lines.map(function (line) {
					var colored = structureLog(line);
					var plain = line.toLowerCase();
					if (plain.indexOf(k) === -1) return colored;
					var mIdx = searchMatchCount++;
					var isCurrent = mIdx === matchIdx;
					// mark keyword occurrences in TEXT segments only (never
					// inside tag attributes); classes from the v3 stylesheet
					// (.blv3-hit rows, mark/mark.cur markers).
					var segs = colored.split(/(<[^>]*>)/);
					var marked = segs.map(function (seg) {
						if (seg.charAt(0) === "<") return seg; // tag, untouched
						var lower = seg.toLowerCase();
						if (lower.indexOf(k) === -1) return seg;
						var re = new RegExp(kwEscaped.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
						return seg.replace(re, function (hit) {
							return '<mark class="' + (isCurrent ? "cur" : "") + '">' + hit + "</mark>";
						});
					}).join("");
					return '<span data-m="' + mIdx + '" class="blv3-hit' + (isCurrent ? " cur" : "") + '">' + marked + "</span>";
				});
				logHtml = rendered.join("\n");
			})();
			// Guard the cursor ONLY when matches shrink below it (log cap
			// rotation); a growing match list must not move the cursor —
			// mid-navigation jumps (1→10 on one ↓ press) otherwise occur when
			// live logs keep appending matched lines.
			if (searchMatchCount > 0 && matchIdx > searchMatchCount - 1) {
				matchIdx = searchMatchCount - 1;
			}

			// prev/next navigation: scroll the log pane to the current match
			function gotoMatch(next) {
				if (searchMatchCount === 0) return;
				var target = (matchIdx + (next ? 1 : -1) + searchMatchCount) % searchMatchCount;
				setMatchIdx(target);
				// scroll after React commits: the data-m span for `target`
				var doScroll = function () {
					var el = logRef.current && logRef.current.querySelector('[data-m="' + target + '"]');
					if (el && el.scrollIntoView) el.scrollIntoView({ block: "center", behavior: "smooth" });
				};
				setTimeout(doScroll, 30);
			}
			// when a NEW search starts, jump to the first match
			useEffect(function () {
				if (search.trim() && searchMatchCount > 0) {
					var el = logRef.current && logRef.current.querySelector('[data-m="0"]');
					if (el && el.scrollIntoView) el.scrollIntoView({ block: "center" });
				}
			}, [search]);

			// Auto-scroll log pane to bottom on new content.
			useEffect(function () {
				if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
			});

			if (!panelOpen) { injectStyles(); return null; }
			injectStyles();

			// header summary: aggregate over discovered×registry (prototype's
			// 2 运行中 / 14 已停止 / 1 异常 chips).
			var sumRunning = 0, sumStopped = 0, sumErr = 0;
			for (const k of keys) {
				var st = s.services[k].status;
				if (st === "running") sumRunning++;
				else if (st === "completed" || st === "killed") sumStopped++;
				else sumErr++;
			}

			return createElement("div", {
				"data-dsh-spring-boot-panel": true,
				className: "blv3-overlay",
				onClick: function (e) { if (e.target === e.currentTarget) s.closePanel(); },
			},
				createElement("div", { className: "blv3-panel" },
					// header: title + summary chips + conn + actions
					createElement("div", { className: "blv3-head" },
						createElement("div", { className: "blv3-title" },
							createElement("h1", null, "Spring Boot Services"),
							createElement("span", { className: "sub" },
								(s.workspaces.length || "–") + " 个工作区 · " + (s.discovered.length || "–") + " 个 Spring Boot 项目")),
						createElement("div", { className: "blv3-summary" },
							sumRunning > 0 ? createElement("span", { className: "blv3-chip ok" },
								createElement("span", { className: "dot" }), sumRunning + " 运行中") : null,
							sumStopped > 0 ? createElement("span", { className: "blv3-chip" },
								createElement("span", { className: "dot" }), sumStopped + " 已停止") : null,
							sumErr > 0 ? createElement("span", { className: "blv3-chip err" },
								createElement("span", { className: "dot" }), sumErr + " 异常") : null),
						createElement("div", { className: "blv3-headright" },
							createElement("span", { className: "blv3-conn" + (s.connected ? "" : " off"), title: s.lastError || undefined },
								createElement("span", { className: "dot" }),
								s.connected ? "DSH 原生认证通道" : (s.lastError || "未连接")),
							createElement("button", {
								className: "blv3-btn ghost",
								onClick: function () { s.discover(); },
								disabled: s.discovering || !s.connected,
							}, "⟳ 重新扫描"),
							createElement("button", {
								className: "blv3-btn ghost",
								onClick: function () { s.closePanel(); },
							}, "关闭 (Esc)"))),
						// start row: workspace project grid first, manual as fallback
					createElement("div", null,
						createElement(ProjectGrid),
						createElement(AdvancedStart)),
					// body: services column + logs (v3 layout)
					createElement("div", { className: "blv3-body" },
							!s.servicesCollapsed
								? createElement("div", { className: "blv3-services" },
									createElement("div", { className: "blv3-colhead" },
										createElement("span", null, "本次会话服务"),
										createElement("span", { className: "spacer" }),
										createElement("button", {
											className: "blv3-collapse",
											title: "收起服务列表（日志区全宽）",
											onClick: function () { s.servicesCollapsed = true; s.emit(); },
										},
											createElement("span", { className: "chev" }, "▾"),
											"收起")),
								keys.length === 0
									? createElement("div", { style: { color: "var(--text-3)", fontStyle: "italic", padding: "14px 12px", fontSize: "11px" } },
										"暂无 — 在上方项目列表点 Start 启动。")
									: createElement("div", { className: "blv3-svclist" },
										keys.map(function (key) {
											return createElement(ServiceRow, { key: key, service: s.services[key], selected: key === selKey });
										})),
								s.lastError
									? createElement("div", { className: "blv3-errorline", title: s.lastError }, s.lastError)
									: null)
							: createElement("button", {
								className: "blv3-collapse",
								onClick: function () { s.servicesCollapsed = false; s.emit(); },
								title: "展开服务列表",
								style: { position: "absolute", left: 0, top: "46px", zIndex: 5, margin: "8px" },
							},
								createElement("span", { className: "chev" }, "▸"),
								"服务"),
						// log column
						createElement("div", { className: "blv3-logs" },
							createElement("div", { className: "blv3-logtoolbar" },
								createElement("div", { className: "blv3-logtitle" },
									createElement("span", { className: "name" },
										sel ? (sel.projectDir || selKey).split("\\").pop() : "（选择左侧服务）"),
									sel && sel.running
										? createElement("span", { className: "blv3-livepill on" }, createElement("span", { className: "dot" }), "实时")
										: sel && selKey && s.streamEnded[selKey]
											? createElement("span", { className: "blv3-livepill off" }, "已结束")
											: null),
								sel && sel.logPath
									? createElement("span", { className: "blv3-logpath", title: sel.logPath },
										"…" + String(sel.logPath).slice(-30))
									: null,
								// search + match navigation (v3)
								createElement("div", { className: "blv3-searchbox" },
									createElement("input", {
										className: "blv3-search",
										value: searchInput,
										placeholder: "检索日志 (Enter · Esc 清除)",
										onChange: function (e) { setSearchInput(e.target.value); },
										onKeyDown: function (e) {
											if (e.key === "Enter") { setSearch(searchInput); setMatchIdx(0); }
											if (e.key === "Escape") { setSearchInput(""); setSearch(""); e.stopPropagation(); }
										},
									}),
									search.trim() && searchMatchCount > 0
										? createElement("span", { className: "blv3-matchnav" },
											createElement("button", { className: "blv3-navbtn", onClick: function () { gotoMatch(false); }, title: "上一处" }, "↑"),
											createElement("span", { style: { padding: "0 4px" } }, (matchIdx + 1) + "/" + searchMatchCount),
											createElement("button", { className: "blv3-navbtn", onClick: function () { gotoMatch(true); }, title: "下一处" }, "↓"))
										: search.trim()
											? createElement("span", { className: "blv3-matchnav" }, "0 处")
											: null)),
							createElement("pre", {
								ref: logRef,
								className: "blv3-logview",
								dangerouslySetInnerHTML: { __html: logHtml.slice(-80000) },
							}),
							// status bar (v3): line count + buffer size + stream state + path
							createElement("div", { className: "blv3-statusbar" },
								createElement("span", { className: "seg" },
									String(rawLog ? rawLog.split("\n").length : 0) + " 行"),
								createElement("span", { className: "seg" },
									"缓冲 " + Math.max(1, Math.round((rawLog || "").length / 1024)) + " KB"),
								createElement("span", { className: "seg" },
									(sel && sel.running ? "实时流 · 300ms" : s.streamEnded[selKey] ? "流已结束" : "等待输出")),
								sel && sel.logPath
									? createElement("span", { className: "seg", style: { marginLeft: "auto" }, title: sel.logPath },
										"…" + String(sel.logPath).slice(-40))
									: null)))));
		}

		// ─── Plugin registration ────────────────────────────────────────
		// Three registrations: the sidebar footer entry (visible trigger), the
		// shell.overlay panel, and a workspaces-fed wiring so the panel can
		// discover projects under the user's registered workspaces without
		// manual path entry. `workspaces` (client runtime service) exposes an
		// ObservableSnapshot list of {workspaceId, path, title, sessionIds};
		// subscribe on mount + read on change.
		var inject = ["slots", "workspaces"];
		function apply(ctx) {
			// Feed workspace paths into the store (live subscription).
			try {
				var wsList = ctx.workspaces && ctx.workspaces.list;
				if (wsList) {
					var pushWs = function () {
						var snap = wsList.getSnapshot();
						var items = (snap && snap.items) || [];
						store.setWorkspaces(items);
					};
					pushWs();
					if (typeof wsList.subscribe === "function") {
						wsList.subscribe(pushWs);
					}
				}
			} catch (e) { /* workspaces service absent — manual path entry still works */ }

			ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register({
				name: "sidebar.footer.action",
				id: "spring-boot-launcher",
				inject: () => ({}),
			}, SpringBootServicesEntry));
			ctx.slots.inject("shell.overlay", () => ctx.slots.register({
				name: "shell.overlay",
				id: "spring-boot-launcher",
				inject: () => ({}),
			}, SpringBootPanelHost));
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
