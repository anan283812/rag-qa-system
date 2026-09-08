/* 会话工作台：会话列表、流式问答、Markdown 回答、引用侧栏与导出。 */

const $ = (id) => document.getElementById(id);

const urlSession = new URLSearchParams(window.location.search).get("session");
let sessionId = urlSession || localStorage.getItem(sessionStorageKey());
if (!sessionId) {
    // 不共用 "default" 会话：每个用户首次进入生成唯一会话，避免跨用户 403 冲突
    sessionId = newSessionId();
    localStorage.setItem(sessionStorageKey(), sessionId);
}
let currentSessionName = "新会话";
let sessions = [];
let currentSources = [];
let chatMode = "auto";
let busy = false;

let streamBox = null;
let streamAnswer = null;
let streamSources = [];
let streamThinking = null;
let kgCache = {};
let kgPromises = {};
let kgCy = null;
let currentKg = { entities: [], relations: [] };
let lastUserQuestion = ""; // 最近一条用户提问（供“生成工单”按钮取故障描述）

/* ============ 基础渲染 ============ */

function scrollBottom() {
    const box = $("messages");
    if (!box || scrollBottom._tick) return;
    scrollBottom._tick = true;
    requestAnimationFrame(() => {
        box.scrollTop = box.scrollHeight;
        scrollBottom._tick = false;
    });
}

function setSessionTag() {
    $("currentSessionId").textContent = sessionId;
}

function welcomeHTML() {
    return (
        '<div class="welcome-card">' +
        '<span class="welcome-eyebrow"><span class="status-dot"></span>知识库已就绪</span>' +
        '<h2>从一个问题开始，把知识变成答案</h2>' +
        '<p class="welcome-sub">系统会先检索知识库，再结合上下文生成带来源的回答。</p>' +
        '<div class="welcome-stats">' +
        '<div class="welcome-stat"><div class="num" id="welcomeFiles">-</div><div class="label">知识库文档</div></div>' +
        '<div class="welcome-stat"><div class="num" id="welcomeChats">-</div><div class="label">累计对话</div></div>' +
        '<div class="welcome-stat"><div class="num" id="welcomeSessions">-</div><div class="label">会话数量</div></div>' +
        '</div>' +
        '<div class="suggestions">' +
        '<div class="suggestions-label">试试这样问</div>' +
        '<div class="suggestion-chips">' +
        '<button class="suggestion-chip" type="button" data-q="公司产品手册中有哪些核心产品？">产品手册</button>' +
        '<button class="suggestion-chip" type="button" data-q="服务器部署时有哪些注意事项？">部署要点</button>' +
        '<button class="suggestion-chip" type="button" data-q="员工手册中关于考勤有哪些规定？">员工手册</button>' +
        '<button class="suggestion-chip" type="button" data-q="帮我总结机器学习基础文档的重点。">知识总结</button>' +
        '</div></div></div>'
    );
}

function renderWelcome() {
    const box = $("messages");
    box.innerHTML = '<div class="empty-tip welcome-state">' + welcomeHTML() + "</div>";
    box.querySelectorAll(".suggestion-chip").forEach((btn) => {
        btn.addEventListener("click", () => quickAsk(btn.dataset.q));
    });
    refreshWelcomeStats();
    renderReferences([]);
    loadKnowledgeGraph([]);
}

async function refreshWelcomeStats() {
    try {
        const data = await api("/stats/overview");
        const fill = (id, value) => {
            const el = document.getElementById(id);
            if (el) el.textContent = value != null ? value : "-";
        };
        fill("welcomeFiles", data.files);
        fill("welcomeChats", data.chats);
        fill("welcomeSessions", data.sessions);
    } catch (e) { /* ignore */ }
}

/* ============ 会话列表 ============ */

function renderSessions() {
    const q = ($("sessionFilter").value || "").trim().toLowerCase();
    const list = sessions.filter((s) => {
        const name = (s.name || "").toLowerCase();
        const id = (s.session_id || "").toLowerCase();
        return !q || name.includes(q) || id.includes(q);
    });
    const box = $("sessionList");
    $("sessionCount").textContent = sessions.length;
    if (!list.length) {
        box.innerHTML = '<div class="empty-block">暂无会话</div>';
        return;
    }
    box.innerHTML = list
        .map(
            (s) =>
                '<button class="chat-session-item ' +
                (s.session_id === sessionId ? "active" : "") +
                '" type="button" data-id="' +
                escapeHtml(s.session_id) +
                '">' +
                '<span class="session-dot"></span>' +
                '<span class="session-line">' +
                '<span class="session-name">' + escapeHtml(s.name || s.session_id) + "</span>" +
                '<span class="session-meta">' + (s.message_count || 0) + " 条 · " + formatTime(s.updated_at) + "</span>" +
                "</span></button>"
        )
        .join("");
    box.querySelectorAll(".chat-session-item").forEach((btn) => {
        btn.addEventListener("click", () => switchSession(btn.dataset.id));
    });
}

async function loadSessions() {
    try {
        const data = await api("/sessions/list");
        sessions = data.sessions || [];
        const current = sessions.find((s) => s.session_id === sessionId);
        if (current) currentSessionName = current.name;
        renderSessions();
    } catch (e) { /* 会话列表加载失败不影响提问 */ }
}

function switchSession(nextId) {
    if (busy || nextId === sessionId) return;
    sessionId = nextId;
    localStorage.setItem(sessionStorageKey(), sessionId);
    $("sessionSidebar").classList.remove("open");
    const item = sessions.find((s) => s.session_id === sessionId);
    currentSessionName = item ? item.name : "新会话";
    $("currentSessionName").textContent = currentSessionName;
    setSessionTag();
    renderSessions();
    loadHistory();
}

function newSessionId() {
    return "sess_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function newSession() {
    if (busy) return;
    sessionId = newSessionId();
    localStorage.setItem(sessionStorageKey(), sessionId);
    $("sessionSidebar").classList.remove("open");
    currentSessionName = "新会话";
    $("currentSessionName").textContent = currentSessionName;
    setSessionTag();
    currentSources = [];
    renderSessions();
    renderWelcome();
}

async function loadHistory() {
    try {
        const data = await api(
            "/history/list?session_id=" + encodeURIComponent(sessionId) + "&page=1&page_size=100"
        );
        if (!data.history || !data.history.length) {
            renderWelcome();
            return;
        }
        $("messages").innerHTML = "";
        data.history.forEach((item) => {
            addMessage("user", item.question);
            addMessage("assistant", item.answer, [], item.thinking);
        });
        scrollBottom();
    } catch (e) {
        toast("对话记录加载失败：" + e.message, "error");
    }
}

/* ============ 消息渲染 ============ */

function setAnswerContent(answer, text, sources) {
    if (!answer) return;
    const markdown = String(text == null ? "" : text);
    answer.dataset.markdown = markdown;
    if (window.marked && window.DOMPurify) {
        const rendered = marked.parse(markdown, { gfm: true, breaks: true });
        answer.innerHTML = DOMPurify.sanitize(String(rendered));
    } else {
        answer.textContent = markdown;
    }
    decorateAnswerDom(answer, sources || []);
    highlightAnswerCode(answer);
}

function decorateAnswerDom(answer, sources) {
    if (!answer || !sources || !sources.length) return;
    const walker = document.createTreeWalker(answer, NodeFilter.SHOW_TEXT);
    const textNodes = [];
    while (walker.nextNode()) textNodes.push(walker.currentNode);
    textNodes.forEach((node) => {
        const value = node.nodeValue || "";
        if (value.indexOf("[来源") === -1) return;
        if (node.parentElement && node.parentElement.closest("code, pre, a")) return;
        const parts = value.split(/\[来源(\d+)\]/g);
        if (parts.length < 2) return;
        const frag = document.createDocumentFragment();
        for (let i = 0; i < parts.length; i++) {
            const part = parts[i];
            if (i % 2 === 1) {
                const num = parseInt(part, 10);
                const idx = num - 1;
                if (idx >= 0 && idx < sources.length) {
                    const link = document.createElement("span");
                    link.className = "src-link";
                    link.dataset.src = String(idx);
                    link.title = "点击查看来源 " + num;
                    link.textContent = "[来源" + num + "]";
                    link.addEventListener("click", () => highlightSource(idx));
                    frag.appendChild(link);
                    continue;
                }
            }
            frag.appendChild(document.createTextNode(part));
        }
        node.parentNode.replaceChild(frag, node);
    });
}

function highlightAnswerCode(answer) {
    if (!answer || !window.hljs) return;
    answer.querySelectorAll("pre code").forEach((code) => {
        try { hljs.highlightElement(code); } catch (e) { /* ignore */ }
    });
}

function decorateAnswerSources(box, sources) {
    if (!box) return;
    const answer = box.querySelector(".answer");
    if (!answer || !answer.textContent.trim()) return;
    setAnswerContent(answer, answer.dataset.markdown || answer.textContent, sources || []);
}

function appendThinkingBlock(container, text) {
    if (localStorage.getItem("rag_show_thinking") === "0") return null;
    const box = document.createElement("div");
    box.className = "thinking-box";
    const head = document.createElement("div");
    head.className = "thinking-head";
    const title = document.createElement("span");
    title.className = "thinking-title";
    title.textContent = "思考过程";
    const toggle = document.createElement("button");
    toggle.className = "source-toggle";
    toggle.textContent = "收起";
    const body = document.createElement("div");
    body.className = "thinking-text";
    body.textContent = text || "";
    toggle.addEventListener("click", () => {
        const open = body.classList.toggle("collapsed");
        toggle.textContent = open ? "展开" : "收起";
    });
    head.append(title, toggle);
    box.append(head, body);
    container.appendChild(box);
    return body;
}

function appendSourceChips(container, sources) {
    if (!sources || !sources.length) return;
    if (container.querySelector(".source-chips")) return;
    const chips = document.createElement("div");
    chips.className = "source-chips";
    sources.forEach((s, i) => {
        const btn = document.createElement("button");
        btn.className = "source-chip";
        btn.type = "button";
        btn.textContent = i + 1 + " " + (s.filename || "未知来源");
        btn.title = "点击查看引用片段";
        btn.addEventListener("click", () => {
            setCurrentSources(sources);
            openReferences();
            highlightSource(i);
        });
        chips.appendChild(btn);
    });
    container.appendChild(chips);
}

function addMessage(role, text, sources, thinking) {
    if (role === "user") lastUserQuestion = text;
    $("messages").querySelector(".welcome-state")?.remove();
    const box = document.createElement("div");
    box.className = "message " + role;
    const bubble = document.createElement("div");
    bubble.className = "bubble";

    if (role === "assistant") {
        const answer = document.createElement("div");
        answer.className = "answer";
        setAnswerContent(answer, text, sources || []);
        bubble.appendChild(answer);
        if (thinking) appendThinkingBlock(bubble, thinking);
        appendSourceChips(bubble, sources || []);
        if (sources && sources.length) {
            setCurrentSources(sources);
            loadKnowledgeGraph(sources);
        }
    } else {
        bubble.textContent = text;
    }
    box.appendChild(bubble);
    $("messages").appendChild(box);
    if (role === "assistant") addCopyButton(box, sources || []);
    scrollBottom();
}

function buildCitationText(answerText, sources) {
    if (!sources || !sources.length) return answerText;
    const lines = ["回答：", answerText, "", "参考资料："];
    sources.forEach((s, i) => {
        const chunk = Number.isInteger(s.chunk_index) && s.chunk_index >= 0 ? "第" + (s.chunk_index + 1) + "段" : "未知片段";
        lines.push("[" + (i + 1) + "] " + (s.filename || "未知来源") + " " + chunk);
        lines.push(s.text || "");
        lines.push("");
    });
    return lines.join("\n").trim();
}

function makeCopyButton(label, text) {
    const btn = document.createElement("button");
    btn.className = "copy-btn";
    btn.textContent = label;
    btn.addEventListener("click", async () => {
        try {
            await navigator.clipboard.writeText(text);
            toast("已复制" + label, "success");
        } catch (e) {
            toast("复制失败，请手动选择文本", "error");
        }
    });
    return btn;
}

function addCopyButton(box, sources) {
    if (!box) return;
    const answer = box.querySelector(".answer");
    if (!answer || !answer.textContent.trim()) return;
    if (box.querySelector(".copy-btn")) return;
    const wrap = document.createElement("div");
    wrap.className = "answer-actions";
    wrap.appendChild(makeCopyButton("复制", answer.textContent));
    if (sources && sources.length) {
        wrap.appendChild(makeCopyButton("复制含来源", buildCitationText(answer.textContent, sources)));
    }
    box.querySelector(".bubble").appendChild(wrap);
}

/* ============ 引用侧栏 ============ */

function renderReferences(sources) {
    currentSources = sources || [];
    $("refCount").textContent = currentSources.length;
    const body = $("refBody");
    if (!currentSources.length) {
        body.innerHTML = '<div class="empty-block">回答包含来源后会显示在这里</div>';
        return;
    }
    body.innerHTML = currentSources
        .map((s, i) =>
            '<div class="ref-item" id="ref-' + i + '">' +
            '<div class="ref-item-head">' +
            '<span class="source-index">' + (i + 1) + "</span>" +
            '<span class="ref-name">' + escapeHtml(s.filename || "未知来源") + "</span>" +
            "</div>" +
            '<div class="ref-meta">' +
            (Number.isInteger(s.chunk_index) && s.chunk_index >= 0 ? "第" + (s.chunk_index + 1) + "段" : "未知片段") +
            ' · 相似度 ' + Math.round((s.similarity || 0) * 100) + "%" +
            (s.category ? ' · ' + escapeHtml(s.category) : "") +
            "</div>" +
            '<div class="ref-text">' + escapeHtml(s.text || "") + "</div>" +
            "</div>"
        )
        .join("");
}

function setCurrentSources(sources) {
    renderReferences(sources);
}

function highlightSource(idx) {
    const target = document.getElementById("ref-" + idx);
    if (!target) return;
    $("refBody").querySelectorAll(".ref-item").forEach((el) => el.classList.remove("active"));
    target.classList.add("active");
    target.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function showRefTab(name) {
    const refs = name === "refs";
    $("refBody").classList.toggle("hidden", !refs);
    $("kgBody").classList.toggle("hidden", refs);
    $("refTabRefs").classList.toggle("active", refs);
    $("refTabKg").classList.toggle("active", !refs);
}

function renderKgGraph(graph) {
    if (kgCy) {
        kgCy.destroy();
        kgCy = null;
    }
    const entities = (graph && graph.entities) || [];
    const relations = (graph && graph.relations) || [];
    if (!entities.length) {
        $("kgStatus").textContent = "暂未提取到知识图谱";
        $("kgStatus").classList.remove("hidden");
        return;
    }
    const elements = [
        ...entities.map((e) => ({
            data: { id: "n_" + e.id, label: e.label, type: e.type || "实体" },
        })),
        ...relations.map((r, i) => ({
            data: {
                id: "e_" + i,
                source: "n_" + r.source,
                target: "n_" + r.target,
                label: r.label,
            },
        })),
    ];
    if (!window.cytoscape) {
        $("kgStatus").textContent = "图谱渲染库未加载";
        $("kgStatus").classList.remove("hidden");
        return;
    }
    $("kgStatus").classList.add("hidden");
    kgCy = cytoscape({
        container: document.getElementById("kgCanvas"),
        elements,
        style: [
            {
                selector: "node",
                style: {
                    "background-color": "#0f766e",
                    "border-color": "#115e59",
                    "border-width": 1,
                    label: "data(label)",
                    color: "#182120",
                    "font-size": 11,
                    "text-valign": "bottom",
                    "text-margin-y": 4,
                    width: 42,
                    height: 42,
                    shape: "round-rectangle",
                },
            },
            {
                selector: "edge",
                style: {
                    width: 1.5,
                    "line-color": "#b45309",
                    "target-arrow-color": "#b45309",
                    "target-arrow-shape": "triangle",
                    "curve-style": "bezier",
                    label: "data(label)",
                    "font-size": 9,
                    color: "#71807c",
                    "text-rotation": "autorotate",
                },
            },
        ],
        layout: { name: "cose", animate: true, fit: true, padding: 20 },
    });
}

function getKgGraph(file) {
    const key = file.storage || file.filename;
    if (!kgPromises[key]) {
        kgPromises[key] = (async () => {
            if (kgCache[key]) return kgCache[key];
            const params = new URLSearchParams({ filename: file.filename });
            if (file.storage) params.set("storage", file.storage);
            const query = params.toString();
            let graph = await api("/kg/file?" + query);
            if (graph.status === "missing") {
                graph = await api("/kg/extract?" + query, { method: "POST" });
            }
            kgCache[key] = graph;
            return graph;
        })();
    }
    return kgPromises[key];
}

async function loadKnowledgeGraph(sources) {
    // 以 storage（回退 filename）去重，同名文件来自不同用户时也能分别取图
    const seen = new Map();
    (sources || []).forEach((s) => {
        if (!s.filename) return;
        const key = s.storage || s.filename;
        if (!seen.has(key)) seen.set(key, s);
    });
    const files = [...seen.values()];
    $("kgStatus").textContent = files.length ? "AI 正在分析文档，提取实体和关系..." : "知识图谱会在这里展示";
    $("kgStatus").classList.remove("hidden");
    if (!files.length) {
        currentKg = { entities: [], relations: [] };
        renderKgGraph(currentKg);
        return;
    }
    const merged = { entities: [], relations: [] };
    const seenEntities = new Set();
    try {
        await Promise.all(files.map((file) => getKgGraph(file)));
    } catch (e) { /* 图谱失败不阻断回答 */ }
    files.forEach((file) => {
        const graph = kgCache[file.storage || file.filename] || {};
        (graph.entities || []).forEach((e) => {
            if (!seenEntities.has(e.id)) {
                seenEntities.add(e.id);
                merged.entities.push(e);
            }
        });
        (graph.relations || []).forEach((r) => {
            if (seenEntities.has(r.source) && seenEntities.has(r.target)) {
                merged.relations.push(r);
            }
        });
    });
    currentKg = merged;
    $("kgStatus").textContent = merged.entities.length
        ? "共 " + merged.entities.length + " 个实体 · " + merged.relations.length + " 条关系"
        : "暂未提取到知识图谱";
    renderKgGraph(merged);
}

function openReferences() {
    $("referencesPanel").classList.add("open");
    document.querySelector(".chat-main").classList.add("ref-open");
}

function closeReferences() {
    $("referencesPanel").classList.remove("open");
    const main = document.querySelector(".chat-main");
    if (main) main.classList.remove("ref-open");
}

/* ============ 流式问答 ============ */

function beginStreamBubble() {
    $("messages").querySelector(".welcome-state")?.remove();
    streamSources = [];
    streamThinking = null;
    streamBox = document.createElement("div");
    streamBox.className = "message assistant";
    const bubble = document.createElement("div");
    bubble.className = "bubble";
    const thinking = document.createElement("div");
    thinking.className = "thinking";
    thinking.innerHTML = '<span class="thinking-ring"></span><span>正在组织回答</span><span class="typing-dots"><span></span><span></span><span></span></span>';
    bubble.appendChild(thinking);
    streamBox.appendChild(bubble);
    $("messages").appendChild(streamBox);
    scrollBottom();
}

function ensureStreamThinking() {
    if (streamThinking) return streamThinking;
    const bubble = streamBox.querySelector(".bubble");
    const dots = bubble.querySelector(".thinking");
    if (dots) dots.remove();
    streamThinking = appendThinkingBlock(bubble, "") || document.createElement("div");
    return streamThinking;
}

function ensureStreamAnswer() {
    if (streamAnswer) return;
    const bubble = streamBox.querySelector(".bubble");
    const dots = bubble.querySelector(".thinking");
    if (dots) dots.remove();
    const answer = document.createElement("div");
    answer.className = "answer stream-cursor";
    answer.textContent = "";
    bubble.appendChild(answer);
    streamAnswer = answer;
}

function ensureStreamSources() {
    if (!streamSources.length) return;
    const bubble = streamBox.querySelector(".bubble");
    appendSourceChips(bubble, streamSources);
}

function setStreamSources(sources) {
    streamSources = sources || [];
    if (streamSources.length) {
        setCurrentSources(streamSources);
        loadKnowledgeGraph(streamSources);
    }
}

function appendThinkingToken(content) {
    ensureStreamThinking().textContent += content;
    scrollBottom();
}

function appendStreamToken(content) {
    ensureStreamAnswer();
    ensureStreamSources();
    streamAnswer.textContent += content;
    scrollBottom();
}

function endStreamBubble() {
    if (streamAnswer) {
        streamAnswer.classList.remove("stream-cursor");
        const box = streamBox;
        const sources = streamSources || [];
        decorateAnswerSources(box, sources);
        addCopyButton(box, sources);
    }
    streamBox = null;
    streamAnswer = null;
    streamSources = [];
    streamThinking = null;
}

function handleChatEvent(data) {
    if (data.type === "sources") {
        setStreamSources(data.sources || []);
    } else if (data.type === "thinking") {
        appendThinkingToken(data.content || "");
    } else if (data.type === "thinking_done") {
        /* 思考阶段结束 */
    } else if (data.type === "token") {
        appendStreamToken(data.content || "");
    } else if (data.type === "done") {
        endStreamBubble();
    } else if (data.type === "error") {
        toast("问答失败：" + (data.message || "AI服务调用失败"), "error");
        endStreamBubble();
    }
}

async function sendQuestion() {
    const input = $("questionInput");
    const question = input.value.trim();
    if (!question || busy) return;
    input.value = "";
    input.style.height = "auto";
    input.disabled = true;
    $("sendBtn").disabled = true;
    busy = true;

    addMessage("user", question);
    beginStreamBubble();
    try {
        const res = await fetch("/chat/stream", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "X-Auth-Token": getAuthToken(),
            },
            body: JSON.stringify({
                question,
                session_id: sessionId,
                category: null,
                mode: chatMode,
            }),
        });
        if (res.status === 401) {
            window.location.href = "/login";
            throw new Error("登录已过期");
        }
        if (!res.ok) {
            let data = null;
            try { data = await res.json(); } catch (e) { /* ignore */ }
            throw new Error((data && data.detail) || "请求失败");
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder("utf-8");
        let buffer = "";
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let idx;
            while ((idx = buffer.indexOf("\n\n")) !== -1) {
                const raw = buffer.slice(0, idx);
                buffer = buffer.slice(idx + 2);
                for (const line of raw.split("\n")) {
                    if (!line.startsWith("data:")) continue;
                    try {
                        handleChatEvent(JSON.parse(line.slice(5).trim()));
                    } catch (e) { /* ignore */ }
                }
            }
        }
    } catch (e) {
        endStreamBubble();
        toast("问答失败：" + e.message, "error");
    } finally {
        busy = false;
        input.disabled = false;
        $("sendBtn").disabled = false;
        loadSessions();
        input.focus();
    }
}

/* ============ 维修工单生成 ============ */

async function generateTicket() {
    if (busy) return;
    const input = $("questionInput");
    const desc = (input.value.trim() || lastUserQuestion || "").trim();
    if (!desc) {
        toast("请先在输入框描述故障，或先发起一次故障问答", "error");
        return;
    }
    busy = true;
    input.disabled = true;
    $("sendBtn").disabled = true;
    $("ticketBtn").disabled = true;
    const statusEl = $("inputStatus");
    if (statusEl) statusEl.textContent = "正在结合知识库生成维修工单…";
    try {
        const res = await fetch("/chat/ticket", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "X-Auth-Token": getAuthToken(),
            },
            body: JSON.stringify({ question: desc, session_id: sessionId }),
        });
        if (res.status === 401) {
            window.location.href = "/login";
            return;
        }
        const data = await res.json().catch(() => null);
        if (!res.ok || !data) {
            throw new Error((data && data.detail) || "工单生成失败");
        }
        addMessage("assistant", data.answer || "工单生成失败", data.source_list || []);
    } catch (e) {
        toast("工单生成失败：" + e.message, "error");
    } finally {
        busy = false;
        input.disabled = false;
        $("sendBtn").disabled = false;
        $("ticketBtn").disabled = false;
        if (statusEl) statusEl.textContent = "";
        loadSessions();
    }
}

function quickAsk(q) {
    const input = $("questionInput");
    input.value = q || "";
    input.focus();
    input.dispatchEvent(new Event("input", { bubbles: true }));
}

/* ============ 会话操作 ============ */

async function exportSession() {
    const url = "/history/export?session_id=" + encodeURIComponent(sessionId) + "&format=md";
    const resp = await fetch(url, { headers: { "X-Auth-Token": getAuthToken() } });
    if (!resp.ok) {
        const d = await resp.json().catch(() => ({}));
        toast(d.detail || "导出失败", "error");
        return;
    }
    const text = await resp.text();
    const blob = new Blob([text], { type: "text/markdown;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "会话_" + sessionId + ".md";
    a.click();
    URL.revokeObjectURL(a.href);
    toast("已导出当前会话");
}

async function clearSession() {
    if (!confirm("确定清空当前会话的全部记录吗？")) return;
    try {
        await api("/history/clear?session_id=" + encodeURIComponent(sessionId), { method: "DELETE" });
        currentSources = [];
        renderWelcome();
        toast("会话已清空");
    } catch (e) {
        toast("清空失败：" + e.message, "error");
    }
}

function openRenameModal() {
    $("sessionNameInput").value = currentSessionName === "新会话" ? "" : currentSessionName;
    $("renameModal").classList.remove("hidden");
    $("sessionNameInput").focus();
}

function closeRenameModal() {
    $("renameModal").classList.add("hidden");
}

async function confirmRename() {
    const name = $("sessionNameInput").value.trim();
    if (!name) {
        toast("请输入会话名称", "error");
        return;
    }
    try {
        await api("/sessions/rename?session_id=" + encodeURIComponent(sessionId), {
            method: "PUT",
            body: JSON.stringify({ name }),
        });
        currentSessionName = name;
        $("currentSessionName").textContent = name;
        closeRenameModal();
        await loadSessions();
        toast("会话已重命名");
    } catch (e) {
        toast("重命名失败：" + e.message, "error");
    }
}

function resizeQuestionInput() {
    const el = $("questionInput");
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 140) + "px";
}

/* ============ 初始化 ============ */

document.addEventListener("DOMContentLoaded", async function () {
    const ok = await requireAuth("/login");
    if (!ok) return;

    $("currentSessionName").textContent = currentSessionName;
    setSessionTag();
    renderSessions();
    renderWelcome();
    loadSessions();
    loadHistory();

    $("newSessionBtn").addEventListener("click", newSession);
    $("sessionFilter").addEventListener("input", renderSessions);
    $("renameSessionBtn").addEventListener("click", openRenameModal);
    $("exportSessionBtn").addEventListener("click", exportSession);
    $("clearSessionBtn").addEventListener("click", clearSession);
    $("exportBtn").addEventListener("click", exportSession);
    $("clearBtn").addEventListener("click", clearSession);
    $("sendBtn").addEventListener("click", sendQuestion);
    $("ticketBtn").addEventListener("click", generateTicket);
    $("toggleReferencesBtn").addEventListener("click", openReferences);
    $("closeReferencesBtn").addEventListener("click", closeReferences);
    $("refTabRefs").addEventListener("click", () => showRefTab("refs"));
    $("refTabKg").addEventListener("click", () => {
        showRefTab("kg");
        if (currentSources.length) loadKnowledgeGraph(currentSources);
    });
    $("toggleSessionsBtn").addEventListener("click", () => $("sessionSidebar").classList.toggle("open"));
    $("confirmRenameBtn").addEventListener("click", confirmRename);
    $("cancelRenameBtn").addEventListener("click", closeRenameModal);
    $("closeRenameBtn").addEventListener("click", closeRenameModal);

    $("questionInput").addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            sendQuestion();
        }
    });
    $("questionInput").addEventListener("input", resizeQuestionInput);
    $("questionInput").addEventListener("focus", () => { $("inputStatus").textContent = ""; });

    document.querySelectorAll("#modeSwitch .mode-btn").forEach((btn) => {
        btn.addEventListener("click", () => {
            chatMode = btn.dataset.mode;
            document.querySelectorAll("#modeSwitch .mode-btn").forEach((b) => b.classList.toggle("active", b === btn));
            $("inputStatus").textContent = btn.dataset.mode === "chat" ? "自由对话模式" : btn.dataset.mode === "rag" ? "仅知识库模式" : "自动模式";
        });
    });

    $("renameModal").addEventListener("click", (e) => {
        if (e.target === $("renameModal")) closeRenameModal();
    });

    document.addEventListener("click", (e) => {
        if (window.innerWidth <= 900) {
            const side = $("sessionSidebar");
            const ref = $("referencesPanel");
            if (side.classList.contains("open") && !e.target.closest("#sessionSidebar") && !e.target.closest("#toggleSessionsBtn")) {
                side.classList.remove("open");
            }
            if (ref.classList.contains("open") && !e.target.closest("#referencesPanel") && !e.target.closest("#toggleReferencesBtn")) {
                ref.classList.remove("open");
            }
        }
    });
});
