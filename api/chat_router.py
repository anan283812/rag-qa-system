"""对话问答接口：混合检索、两阶段生成与 SSE 流式输出。"""

import json

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from config.rag_config import build_prompt, get_config
from core.auth import require_auth
from core.database import get_user_llm_config, load_chat_memory, require_session_access, save_chat_record
from core.llm_client import llm_chat, llm_chat_stream, resolve_user_llm_config
from core.logger import write_log
from core.query_rewrite import rewrite_query
from core.rag_engine import bm25_search, hybrid_search_with_rerank
from core.ticket_engine import (
    build_ticket_prompt,
    extract_ticket_json,
    normalize_ticket,
    render_ticket_markdown,
)

router = APIRouter(prefix="", tags=["对话问答"])


def _user_llm_config(username: str | None) -> dict | None:
    """加载当前用户的私有模型配置；未启用时返回 None 使用系统默认模型。"""
    if not username:
        return None
    return resolve_user_llm_config(get_user_llm_config(username))

MAX_QUESTION_LENGTH = 2000
NO_CONTEXT_ANSWER = "这个我暂时没找到相关资料，换个问法试试，或者先上传相关文档？"
GENERAL_PROMPT = (
    "你在和一位朋友聊天。他用中文和你说话，你就用自然、随和的中文回应，"
    "像正常聊天一样，别端着，别用'作为AI助手'这类腔调。"
    "能答就好好答，不知道就直说不知道。\n"
    "历史对话：{history}\n"
    "用户消息：{question}\n"
)


class ChatRequest(BaseModel):
    question: str = Field(..., min_length=1, max_length=MAX_QUESTION_LENGTH)
    session_id: str = Field("default", min_length=1, max_length=128)
    top_k: int | None = Field(None, ge=1, le=10)
    temperature: float | None = Field(None, ge=0.0, le=1.0)
    category: str | None = Field(None, max_length=50)
    mode: str = Field("auto", pattern="^(auto|rag|chat)$")


def _retrieve(
    question: str,
    top_k: int,
    category: str | None = None,
    use_rerank: bool = False,
    owner: str | None = None,
):
    """混合召回（可选精排）后按相似度阈值过滤；BM25 命中的片段保留，弥补语义阈值误杀。"""
    cfg = get_config()
    threshold = cfg["similarity_threshold"]
    rerank_top_k = cfg.get("rerank_top_k", top_k)
    valid_context = []
    source_info = []
    hits = (
        hybrid_search_with_rerank(question, top_k, category, use_rerank, rerank_top_k, owner=owner)
        if owner
        else hybrid_search_with_rerank(question, top_k, category, use_rerank, rerank_top_k)
    )
    for hit in hits:
        sim = hit.get("similarity")
        if sim is not None and sim < threshold and hit.get("bm25_score") is None:
            continue
        filename = hit.get("filename") or "未知来源"
        chunk_index = hit.get("chunk_index")
        if chunk_index is None:
            chunk_index = -1
        valid_context.append(hit["document"])
        source_info.append(
            {
                "text": hit["document"],
                "filename": filename,
                "chunk_index": chunk_index,
                "category": hit.get("category"),
                "similarity": sim,
                "bm25_score": hit.get("bm25_score"),
                "rerank_score": hit.get("rerank_score"),
                "storage": hit.get("storage"),
            }
        )
        write_log(f"命中片段：{filename}#{chunk_index}，相似度 {sim}，BM25 {hit.get('bm25_score')}")
    return valid_context, source_info


def _labeled_context(valid_context, source_info) -> str:
    lines = [
        f"[来源{i}：{source['filename']}#{source['chunk_index']}] {doc}"
        for i, (source, doc) in enumerate(zip(source_info, valid_context), 1)
    ]
    return "\n".join(lines)


def _build_thinking_prompt(q: str, labeled_context: str, memory_context: str) -> str:
    return (
        "在回答用户问题之前，先在脑子里过一遍（只输出你的思考过程，不要给最终答案）：\n"
        "1. 他到底想问什么，有没有隐含的意思；\n"
        "2. 参考资料够不够回答，哪些能直接用，哪些只能靠猜；\n"
        "3. 缺什么信息，要不要提醒他；\n"
        "4. 打算怎么组织回答。\n"
        "用条目简要写，不超过400字。\n"
        f"历史对话：{memory_context}\n"
        f"参考资料：{labeled_context}\n"
        f"问题：{q}\n"
    )


def _build_answer_prompt(q, valid_context, source_info, memory_context, template, thinking=""):
    labeled_context = (
        _labeled_context(valid_context, source_info)
        if valid_context
        else "未检索到相关参考资料（请基于通用知识回答，并明确说明这一点）"
    )
    prompt = build_prompt(template, memory_context, labeled_context, q)
    if thinking and thinking.strip():
        prompt += "\n\n思考过程：\n" + thinking.strip()
    return prompt


def _sse(data: dict) -> str:
    return f"data: {json.dumps(data, ensure_ascii=False)}\n\n"


def _prepare_retrieval(payload: ChatRequest, cfg: dict, allow_rewrite: bool = True):
    """加载会话记忆并按需做多轮问题改写，返回改写后用于检索的问题。"""
    memory_context = load_chat_memory(payload.session_id)
    retrieve_q = payload.question.strip()
    if allow_rewrite and cfg.get("rewrite_enabled", False) and memory_context.strip():
        rewritten = rewrite_query(retrieve_q, memory_context)
        if rewritten != retrieve_q:
            write_log(f"多轮问题改写：{retrieve_q} -> {rewritten}")
        retrieve_q = rewritten
    return retrieve_q, memory_context


def _resolve_mode(payload: ChatRequest, cfg: dict):
    """返回 (是否走自由对话, 召回问题, 会话记忆)。"""
    if payload.mode == "chat":
        return True, payload.question.strip(), load_chat_memory(payload.session_id)
    retrieve_q, memory_context = _prepare_retrieval(payload, cfg, allow_rewrite=True)
    return False, retrieve_q, memory_context


@router.post("/chat")
def chat(payload: ChatRequest, current: dict = Depends(require_auth)):
    q = payload.question.strip()
    if not q:
        raise HTTPException(status_code=400, detail="问题不能为空")
    require_session_access(payload.session_id, current)

    cfg = get_config()
    top_k = payload.top_k or cfg["top_k"]
    temperature = payload.temperature if payload.temperature is not None else cfg["temperature"]
    user_llm = _user_llm_config(current.get("username"))
    kb_owner = None if current.get("role") == "admin" else current.get("username")
    write_log(f"用户提问：{q}")

    use_general, retrieve_q, memory_context = _resolve_mode(payload, cfg)
    valid_context = []
    source_info = []
    if (
        not use_general
        and payload.mode == "auto"
        and not bm25_search(retrieve_q, top_k, payload.category, kb_owner)
    ):
        use_general = True
    if not use_general:
        valid_context, source_info = _retrieve(
            retrieve_q,
            top_k,
            payload.category,
            use_rerank=bool(cfg.get("rerank_enabled", False)),
            owner=kb_owner,
        )
        if payload.mode == "auto" and not valid_context:
            use_general = True

    if use_general:
        prompt = GENERAL_PROMPT.format(history=memory_context, question=q)
        answer = llm_chat(prompt, temperature, user_llm)
        save_chat_record(payload.session_id, q, answer, owner=current.get("username"))
        return {
            "question": q,
            "answer": answer,
            "thinking": "",
            "source_list": [],
            "session_id": payload.session_id,
            "found": False,
        }

    thinking_enabled = bool(cfg.get("thinking_enabled", True))
    if not valid_context and not thinking_enabled:
        save_chat_record(payload.session_id, q, NO_CONTEXT_ANSWER, owner=current.get("username"))
        write_log(f"未检索到有效资料，跳过模型调用：{q}")
        return {
            "question": q,
            "answer": NO_CONTEXT_ANSWER,
            "source_list": [],
            "session_id": payload.session_id,
            "found": False,
        }

    thinking = ""
    if thinking_enabled:
        thinking_label = (
            _labeled_context(valid_context, source_info)
            if valid_context
            else "未检索到相关参考资料（请基于通用知识回答，并明确说明这一点）"
        )
        try:
            thinking = (
                llm_chat(_build_thinking_prompt(q, thinking_label, memory_context), temperature, user_llm) or ""
            ).strip()
        except HTTPException as exc:
            write_log(f"思考过程生成失败：{exc}")
            thinking = ""

    prompt = _build_answer_prompt(
        q, valid_context, source_info, memory_context, cfg["prompt_template"], thinking
    )
    answer = llm_chat(prompt, temperature, user_llm)
    save_chat_record(payload.session_id, q, answer, thinking=thinking, owner=current.get("username"))
    return {
        "question": q,
        "answer": answer,
        "thinking": thinking,
        "source_list": source_info,
        "session_id": payload.session_id,
        "found": True,
    }


@router.post("/chat/stream")
def chat_stream(payload: ChatRequest, current: dict = Depends(require_auth)):
    q = payload.question.strip()
    if not q:
        raise HTTPException(status_code=400, detail="问题不能为空")
    require_session_access(payload.session_id, current)

    cfg = get_config()
    top_k = payload.top_k or cfg["top_k"]
    temperature = payload.temperature if payload.temperature is not None else cfg["temperature"]
    user_llm = _user_llm_config(current.get("username"))
    kb_owner = None if current.get("role") == "admin" else current.get("username")
    write_log(f"用户提问（流式）：{q}")

    use_general, retrieve_q, memory_context = _resolve_mode(payload, cfg)
    valid_context = []
    source_info = []
    if (
        not use_general
        and payload.mode == "auto"
        and not bm25_search(retrieve_q, top_k, payload.category, kb_owner)
    ):
        use_general = True
    if not use_general:
        valid_context, source_info = _retrieve(
            retrieve_q,
            top_k,
            payload.category,
            use_rerank=bool(cfg.get("rerank_enabled", False)),
            owner=kb_owner,
        )
        if payload.mode == "auto" and not valid_context:
            use_general = True

    if use_general:
        def general_stream():
            yield _sse({"type": "sources", "sources": [], "found": False})
            parts = []
            prompt = GENERAL_PROMPT.format(history=memory_context, question=q)
            try:
                for token in llm_chat_stream(prompt, temperature, user_llm):
                    parts.append(token)
                    yield _sse({"type": "token", "content": token})
            except Exception as exc:
                write_log(f"自由对话流式回答中断：{exc}")
                yield _sse({"type": "error", "message": str(getattr(exc, "detail", "AI服务调用失败"))})
                return
            finally:
                # 客户端断开（GeneratorExit）或异常中断时也要落库，避免丢历史
                answer = "".join(parts)
                if answer.strip():
                    save_chat_record(payload.session_id, q, answer, owner=current.get("username"))
            yield _sse({"type": "done", "answer": answer, "thinking": ""})

        return StreamingResponse(
            general_stream(),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    thinking_enabled = bool(cfg.get("thinking_enabled", True))
    if not valid_context and not thinking_enabled:
        save_chat_record(payload.session_id, q, NO_CONTEXT_ANSWER, owner=current.get("username"))
        write_log(f"未检索到有效资料，跳过模型调用（流式）：{q}")
        events = [
            _sse({"type": "sources", "sources": [], "found": False}),
            _sse({"type": "token", "content": NO_CONTEXT_ANSWER}),
            _sse({"type": "done", "answer": NO_CONTEXT_ANSWER}),
        ]
        return StreamingResponse(iter(events), media_type="text/event-stream")

    no_context_label = "未检索到相关参考资料（请基于通用知识回答，并明确说明这一点）"
    thinking_prompt = (
        _build_thinking_prompt(
            q,
            _labeled_context(valid_context, source_info) if valid_context else no_context_label,
            memory_context,
        )
        if thinking_enabled
        else None
    )

    def event_stream():
        yield _sse({"type": "sources", "sources": source_info, "found": bool(valid_context)})
        thinking = ""
        if thinking_prompt:
            try:
                for token in llm_chat_stream(thinking_prompt, temperature, user_llm):
                    thinking += token
                    yield _sse({"type": "thinking", "content": token})
            except Exception as exc:
                write_log(f"思考过程流式生成中断：{exc}")
                thinking = ""
            yield _sse({"type": "thinking_done", "content": thinking})

        prompt = _build_answer_prompt(
            q, valid_context, source_info, memory_context, cfg["prompt_template"], thinking
        )
        parts = []
        try:
            for token in llm_chat_stream(prompt, temperature, user_llm):
                parts.append(token)
                yield _sse({"type": "token", "content": token})
        except Exception as exc:
            write_log(f"流式回答中断：{exc}")
            message = str(getattr(exc, "detail", "AI服务调用失败"))
            yield _sse({"type": "error", "message": message})
            return
        finally:
            # 客户端断开（GeneratorExit）或异常中断时也要落库，避免丢历史
            answer = "".join(parts)
            if answer.strip():
                save_chat_record(
                    payload.session_id, q, answer, thinking=thinking, owner=current.get("username")
                )

        yield _sse({"type": "done", "answer": answer, "thinking": thinking})

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


class TicketRequest(BaseModel):
    """工单生成请求：question 为故障描述（一般取会话最近一次用户提问）。"""
    question: str = Field(..., min_length=1, max_length=MAX_QUESTION_LENGTH)
    session_id: str = Field("default", min_length=1, max_length=128)


@router.post("/chat/ticket")
def generate_ticket(payload: TicketRequest, current: dict = Depends(require_auth)):
    """把故障描述结合知识库检索结果，生成结构化维修工单（AI 草稿）。"""
    q = payload.question.strip()
    if not q:
        raise HTTPException(status_code=400, detail="请先描述故障")
    require_session_access(payload.session_id, current)

    cfg = get_config()
    user_llm = _user_llm_config(current.get("username"))
    kb_owner = None if current.get("role") == "admin" else current.get("username")
    write_log(f"生成维修工单请求：{q}")

    valid_context, source_info = _retrieve(
        q,
        cfg["top_k"],
        None,
        use_rerank=bool(cfg.get("rerank_enabled", False)),
        owner=kb_owner,
    )
    labeled = _labeled_context(valid_context, source_info) if valid_context else ""
    prompt = build_ticket_prompt(labeled, q)

    ticket = None
    raw = ""
    for attempt in range(2):
        try:
            raw = llm_chat(prompt, 0.2 if attempt == 0 else 0.1, user_llm) or ""
        except HTTPException as exc:
            write_log(f"工单生成模型调用失败：{exc}")
            if attempt == 0:
                continue
            raise HTTPException(status_code=500, detail=f"工单生成失败：{exc.detail}")
        ticket = extract_ticket_json(raw)
        if ticket is not None:
            break
        # 第一次解析失败：追加“只输出 JSON”约束再试一次
        prompt = prompt + "\n请只输出 JSON 对象本身，不要任何其它文字、解释或代码块。"
    if ticket is None:
        raise HTTPException(status_code=502, detail="工单生成失败：模型输出无法解析，请重试")

    ticket = normalize_ticket(ticket)
    md = render_ticket_markdown(ticket)
    save_chat_record(
        payload.session_id, f"[生成维修工单] {q}", md, thinking="", owner=current.get("username")
    )
    write_log(f"维修工单生成成功：{q}")
    return {
        "question": q,
        "ticket": ticket,
        "answer": md,
        "source_list": source_info,
        "session_id": payload.session_id,
        "found": bool(valid_context),
    }
