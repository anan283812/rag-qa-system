"""维修工单生成引擎：把故障问答转化为结构化维修工单（项目原创增量模块）。

设计说明：
- 复用 rag-qa-system 的检索结果与 LLM 调用能力；
- 通过专用 Prompt 让大模型输出固定结构的 JSON 工单；
- 提供容错解析（容忍 markdown 代码围栏、前后多余文字）与字段规整；
- 渲染为 Markdown 工单文本，前端可直接展示/复制。
"""

import json
import re

# 工单标准字段（顺序即展示顺序）
TICKET_KEYS = [
    "设备型号",
    "故障现象",
    "可能原因",
    "排查建议",
    "所需备件",
    "工时预估",
    "处理建议",
    "安全提示",
]

TICKET_PROMPT = (
    "你是工程机械售后服务站的资深服务工程师。请根据下方的参考资料和用户描述的故障，"
    "生成一张结构化的维修工单草稿。\n"
    "硬性要求：\n"
    "1. 只输出一个 JSON 对象本身，不要输出任何解释、列表外的文字或 markdown 代码块围栏；\n"
    "2. JSON 字段固定为："
    "\"设备型号\"(字符串，用户未说明则填\"待确认\")、"
    "\"故障现象\"(字符串，概括用户描述)、"
    "\"可能原因\"(字符串数组，依据资料给出，资料没有的写\"待现场确认\")、"
    "\"排查建议\"(字符串数组，按可执行顺序给出排查步骤，依据资料)、"
    "\"所需备件\"(字符串数组，资料明确列出的按资料给出；资料未列时，结合该故障常见维修给出最可能的常用备件清单，并在该项注明\"常见备件，以现场检查为准\")、"
    "\"工时预估\"(字符串，优先按资料；资料无标准时按该故障常见维修工时给出合理经验区间如\"0.5-1小时\"\"2-4小时\"；确需现场拆检才能确定时才写\"待拆检评估\")、"
    "\"处理建议\"(字符串)、"
    "\"安全提示\"(字符串，必须包含停机、泄压、佩戴防护等安全提醒)；\n"
    "3. 内容必须基于参考资料作答，严禁编造资料中没有的故障码含义、参数数值或维修结论；"
    "参考资料未覆盖的部分如实填写\"待确认/待现场检查\"；\n"
    "4. 所有字段值使用中文。\n"
    "参考资料：\n{context}\n"
    "用户描述的故障：{question}\n"
)


def build_ticket_prompt(context: str, question: str) -> str:
    """组装工单生成 Prompt。context 为已带 [来源N] 标签的检索上下文。"""
    if not context or not context.strip():
        context = "（未检索到相关资料，请基于通用工程机械维修常识谨慎作答，避免编造具体型号参数，并在相应字段注明\"待确认\"）"
    return TICKET_PROMPT.format(context=context.strip(), question=question.strip())


def extract_ticket_json(raw: str) -> dict | None:
    """从模型输出中容错提取 JSON 对象；失败返回 None。"""
    if not raw:
        return None
    text = raw.strip()
    fence = re.search(r"```(?:json)?\s*([\s\S]*?)```", text, re.IGNORECASE)
    if fence:
        text = fence.group(1).strip()
    start, end = text.find("{"), text.rfind("}")
    if start == -1 or end <= start:
        return None
    try:
        data = json.loads(text[start : end + 1])
    except (ValueError, TypeError):
        return None
    return data if isinstance(data, dict) else None


def normalize_ticket(data: dict) -> dict:
    """规整字段：补齐缺失键、清洗列表、统一兜底文案。"""
    out = {k: "待确认" for k in TICKET_KEYS}
    for k in TICKET_KEYS:
        v = data.get(k, "待确认")
        if v is None or v == "" or v == [] or v == {}:
            v = "待确认"
        if isinstance(v, list):
            v = [str(x).strip() for x in v if str(x).strip()]
            v = v or ["待确认"]
        out[k] = v
    # 保留模型给出的额外字段（如"报修单号建议"等）
    for k, v in data.items():
        if k not in out and v not in (None, ""):
            out[k] = v
    return out


def _as_list(value) -> list:
    if isinstance(value, list):
        return [str(x).strip() for x in value if str(x).strip()] or ["待确认"]
    if isinstance(value, str):
        items = [x.strip() for x in re.split(r"[;；\n]+", value) if x.strip()]
        return items or ["待确认"]
    return ["待确认"]


def _list_md(items: list) -> str:
    return "\n".join(f"{i}. {it}" for i, it in enumerate(items, 1))


def render_ticket_markdown(t: dict) -> str:
    """将规整后的工单 dict 渲染为 Markdown 文本（前端展示/复制用）。"""
    md = [
        "## 🛠️ 维修工单（AI 草稿）",
        "",
        f"- **设备型号**：{t.get('设备型号', '待确认')}",
        f"- **故障现象**：{t.get('故障现象', '待确认')}",
        "",
        "**可能原因**",
        _list_md(_as_list(t.get("可能原因"))),
        "",
        "**排查建议**",
        _list_md(_as_list(t.get("排查建议"))),
        "",
        "**所需备件**",
        _list_md(_as_list(t.get("所需备件"))),
        "",
        f"- **工时预估**：{t.get('工时预估', '待评估')}",
        f"- **处理建议**：{t.get('处理建议', '待确认')}",
        f"- **安全提示**：{t.get('安全提示', '作业前请停机、泄压并遵守厂家安全规范')}",
        "",
        "> ⚠️ 本工单由 AI 依据知识库资料自动生成，供报修流转参考，请以现场核实与厂商维修规范为准。",
    ]
    return "\n".join(md)
