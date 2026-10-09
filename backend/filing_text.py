"""
10-K 正文抽取与逐年比对
=======================

研究 Agent 原本只做了两件事：列申报清单、拉 XBRL 数字。
但"不用自己翻几百页 PDF"这个承诺，缺的正是**正文**那一半——
管理层讨论、风险因素这些只有文字里才有的东西。

这个模块补上它，重点是 Item 1A 风险因素的逐年变化：
上市公司每年重写这一章，新增一条往往意味着管理层真的开始担心某件事，
常常比财务数字更早反映问题。专业分析师确实在做这个对比，
因为两份各几十页的法律文本人工对照一遍要两小时。

**机械对比在本地做完，LLM 只负责解读。**
difflib 算出哪些段落是新增/删除的（确定性、可复算、零成本），
只把这部分送给模型。这样既省掉 90% 以上的 token，
又保证每一条结论都能对回原文的具体段落。
"""

from __future__ import annotations

import html
import re
from typing import Any, Dict, List, Optional, Tuple

import research

# Item 1A 的起止。SEC 文件的排版千奇百怪：有的用 "Item 1A." 有的用
# "ITEM 1A" 再加全角空格，中间还可能夹 &nbsp; 或 <b> 标签残留。
# 所以统一在纯文本上用宽松的正则找，而不是依赖 HTML 结构。
_ITEM_1A = re.compile(r"item\s*1a[.\s:\-—]*\s*risk\s*factors", re.I)

# 微软这类公司正文里的标题只写 "Item 1A"，"Risk Factors" 几个字
# 根本不跟在后面（排版上是独立样式，清洗后就没了）。只认严格写法的话，
# 唯一能匹配上的反而是目录项，截出来几十个字符直接被长度门槛丢掉。
#
# 但放宽之后会撞上正文里的交叉引用："refer to Risk Factors
# (Part I, Item 1A of this Form 10-K)" —— 一份 10-K 里有好几处。
# 用否定前瞻把这些挡掉：真正的标题后面不会紧跟 of / above / 右括号。
_ITEM_1A_LOOSE = re.compile(
    r"item\s*1a\b(?![.\s:\-—]*\s*\)|\s*(?:of|above|below|herein|in\s+this)\b)", re.I)
_ITEM_1B = re.compile(r"item\s*1b[.\s:\-—]*\s*unresolved", re.I)
_ITEM_2 = re.compile(r"item\s*2[.\s:\-—]*\s*propert", re.I)

# 外国发行人交的是 20-F，章节编号体系完全不同：风险因素在 Item 3 的
# D 小节，而不是 Item 1A。中概 ADR（BABA、NIO 等）全走这条路径，
# 不支持的话这一大类公司直接用不了这个功能。
_ITEM_3D = re.compile(r"(?:item\s*3[.\s:\-—]*\s*)?d[.\s:\-—]+\s*risk\s*factors", re.I)
_ITEM_4 = re.compile(r"item\s*4[.\s:\-—]*\s*information\s+on\s+the\s+company", re.I)

# 目录里也会出现 "Item 1A. Risk Factors"，但后面紧跟页码且段落很短。
# 取最后一次出现通常就是正文（目录在前、正文在后）。
_MIN_SECTION_CHARS = 2000


def _strip_html(raw: str) -> str:
    """把 SEC 的 HTML 变成纯文本。

    不引 BeautifulSoup：这里只需要去标签 + 规整空白，
    正则足够，也省掉一个依赖。
    """
    s = re.sub(r"(?is)<(script|style)[^>]*>.*?</\1>", " ", raw)
    # 块级标签换成**空行**，保住段落边界——段落是后面做 diff 的基本单位。
    # 必须是两个换行而不是一个：paragraphs() 按空行切分，只给单换行的话
    # 整章会糊成一个段落，diff 直接退化成"全文都变了"或"全文都没变"。
    s = re.sub(r"(?i)<(br|/p|/div|/tr|/h[1-6])[^>]*>", "\n\n", s)
    s = re.sub(r"(?s)<[^>]+>", " ", s)
    s = html.unescape(s)
    s = s.replace("\u00a0", " ").replace("\u200b", "")
    s = re.sub(r"[ \t]+", " ", s)
    s = re.sub(r"\n\s*\n\s*", "\n\n", s)
    return s.strip()


def extract_risk_factors(text: str) -> Optional[str]:
    """从 10-K 全文里切出 Item 1A 风险因素章节。

    先试严格写法（Item 1A + Risk Factors 相邻），没有结果再退到宽松写法。
    候选可能有好几个（目录项、正文标题），统一按"够长且最长的那个"取胜——
    目录项后面紧跟着就是下一个条目，长度上自然出局。
    """
    # 两种写法的候选都要收：微软正文标题只写 "Item 1A"，但它的**目录**里
    # 反而是规范的 "Item 1A. Risk Factors"。只要严格写法命中了（哪怕命中的
    # 是目录），就不去试宽松写法的话，正文标题永远找不到。
    starts = {m.end() for m in _ITEM_1A.finditer(text)}
    starts |= {m.end() for m in _ITEM_1A_LOOSE.finditer(text)}
    starts |= {m.end() for m in _ITEM_3D.finditer(text)}      # 20-F
    if not starts:
        return None

    bounded = None        # 找到了下一章节作为结尾的候选
    unbounded = None      # 没找到结尾，一路吃到文末的候选

    for start in sorted(starts):
        tail = text[start:]
        ends = [m.start() for m in
                (_ITEM_1B.search(tail), _ITEM_2.search(tail),
                 _ITEM_4.search(tail)) if m]
        section = tail[:min(ends)].strip() if ends else tail.strip()
        # 目录项会命中同样的正则，但截出来只有几十个字符
        if len(section) < _MIN_SECTION_CHARS:
            continue
        if ends:
            if bounded is None or len(section) > len(bounded):
                bounded = section
        elif unbounded is None or len(section) > len(unbounded):
            unbounded = section

    # 有明确结尾的优先。没结尾意味着一路吃到了文末——那基本是整份 10-K
    # 而不是风险因素章节，拿它做比对等于在比整本年报，结论全是噪声。
    # 实在只有这一种候选时才退而求其次，并由调用方的长度检查兜底。
    return bounded if bounded is not None else unbounded


def paragraphs(section: str, min_chars: int = 120) -> List[str]:
    """切成段落，丢掉页眉页脚和过短的碎片。

    太短的片段（页码、表格残留、单行标题）做 diff 时全是噪声，
    会把真正的变化淹掉。
    """
    out = []
    for p in re.split(r"\n\s*\n", section):
        p = re.sub(r"\s+", " ", p).strip()
        if len(p) < min_chars:
            continue
        # 纯页码 / 页脚
        if re.fullmatch(r"[\d\s\-|·]+", p):
            continue
        out.append(p)
    return out


def _normalize(p: str) -> str:
    """做相似度比较用的归一化形式。

    年份、金额、百分比每年都会变，但那不代表风险本身变了。
    把它们抹成占位符，才能认出"同一条风险，只是数字更新了"。
    """
    s = p.lower()
    s = re.sub(r"\d[\d,.]*%?", "#", s)
    s = re.sub(r"[^a-z#\s]", " ", s)
    s = re.sub(r"\s+", " ", s)
    return s.strip()


_SHINGLE_N = 5


def _shingles(text: str, n: int = _SHINGLE_N) -> set:
    """归一化后的 n 元词组集合。"""
    w = _normalize(text).split()
    if len(w) < n:
        return set(w)                       # 太短就退化成词集合
    return {" ".join(w[i:i + n]) for i in range(len(w) - n + 1)}


def _coverage(para: str, pool: set) -> float:
    """这个段落有多少比例的 n 元词组，在对照年份的正文里出现过。"""
    sh = _shingles(para)
    if not sh:
        return 1.0
    return len(sh & pool) / len(sh)


def diff_sections(old: List[str], new: List[str],
                  threshold: float = 0.5) -> Dict[str, List[str]]:
    """逐年比对，判断哪些段落是真正新增/删除的。

    **不做逐段配对，而是拿每个段落去对照年份的整篇正文里找覆盖。**

    一开始写的是逐段模糊匹配（difflib 两两算相似度，超过阈值就算同一条）。
    在合成用例上很漂亮，拿真实年报一跑就崩了：苹果 2024→2025 报出
    40% 的段落是"新增"，里面全是"海外销售占多数""制造外包在中国大陆"
    这种每年必写的内容。

    原因是公司每年会重新切分段落——去年拆成两段的今年合成一段。
    逐段配对时，一段对半段的相似度最高也就 0.5，怎么调阈值都救不回来
    （实测阈值从 0.75 降到 0.5，误报只从 38 段降到 29 段）。

    改成覆盖率后同一组数据降到 9%，而且"制造外包"那段的得分
    从 0.15 回到 0.84。合并拆分不再有影响，因为比的是整篇而不是单段。
    """
    old_pool: set = set()
    for p in old:
        old_pool |= _shingles(p)
    new_pool: set = set()
    for p in new:
        new_pool |= _shingles(p)

    added = [p for p in new if _coverage(p, old_pool) < threshold]
    removed = [p for p in old if _coverage(p, new_pool) < threshold]
    return {"added": added, "removed": removed}


# ----------------------------------------------------------------------
# 取两份最近的 10-K
# ----------------------------------------------------------------------

def _recent_10k(symbol: str, count: int = 2) -> Tuple[List[Dict[str, Any]], Optional[str]]:
    info = research.annual_reports(symbol, count)
    if not info.get("found"):
        return [], info.get("reason", "找不到该公司的 SEC 申报")
    reports = info.get("reports", [])
    if len(reports) < count:
        return reports, (f"只找到 {len(reports)} 份年报，"
                         f"至少需要 {count} 份才能做逐年对比")
    return reports[:count], None


# 正文动辄几 MB，截断一下保护内存和后续处理；风险因素章节通常在前半部分
_MAX_DOC_CHARS = 4_000_000

# 送进模型的段落数上限。真实案例里一年新增 5~15 条是常态，
# 超过 40 条基本说明章节被整体重写了，再多送也没有边际价值
_MAX_SEND = 40


def risk_changes(symbol: str, use_llm: bool = True) -> Dict[str, Any]:
    """10-K 风险因素的逐年变化。

    流程：取最近两份年报 → 抽 Item 1A → 切段落 → 本地 diff →
    （可选）把变化的段落交给 LLM 解读。

    LLM 不可用时照样返回 diff 结果，只是没有解读——
    和项目其他部分一样，功能降级但不报错。
    """
    sym = symbol.strip().upper()
    docs, err = _recent_10k(sym, 2)
    if err:
        return {"symbol": sym, "found": False, "reason": err}

    sections = []
    for d in docs:
        try:
            raw = research._get_text(d["url"])
        except Exception as exc:                      # noqa: BLE001
            return {"symbol": sym, "found": False,
                    "reason": f"下载 {d['form']}（{d['filingDate']}）失败：{exc}"}
        sec = extract_risk_factors(_strip_html(raw[:_MAX_DOC_CHARS]))
        if not sec:
            return {"symbol": sym, "found": False,
                    "reason": f"{d['filingDate']} 那份年报里没能定位到 Item 1A 风险因素章节"}
        sections.append({"doc": d, "paras": paragraphs(sec), "chars": len(sec)})

    new, old = sections[0], sections[1]
    d = diff_sections(old["paras"], new["paras"])

    # 可信度自检。
    #
    # SEC 文件的排版没有统一标准，总有公司的章节定位会偏——实测 8 家里
    # 有 2 家（一家 20-F、一家申报量极大的银行）抽出来的章节明显不对，
    # 表现就是"绝大多数段落都是新增"。真实的逐年变化通常在 1%~25%。
    #
    # 这种时候宁可承认不确定，也不能把噪声当洞察端给用户：
    # 一份"97% 的风险是新增的"报告既没用，又会让人不再信任这个功能。
    # 同时也跳过模型调用——拿错的输入去生成解读纯属浪费钱。
    ratio = len(d["added"]) / max(1, len(new["paras"]))
    suspect = ratio > 0.6

    new_year = (new["doc"].get("reportDate") or new["doc"]["filingDate"])[:4]
    old_year = (old["doc"].get("reportDate") or old["doc"]["filingDate"])[:4]

    result = {
        "symbol": sym,
        "found": True,
        "newFiling": {"form": new["doc"]["form"], "date": new["doc"]["filingDate"],
                      "year": new_year, "url": new["doc"]["url"],
                      "paragraphs": len(new["paras"]), "chars": new["chars"]},
        "oldFiling": {"form": old["doc"]["form"], "date": old["doc"]["filingDate"],
                      "year": old_year, "url": old["doc"]["url"],
                      "paragraphs": len(old["paras"]), "chars": old["chars"]},
        "addedCount": len(d["added"]),
        "removedCount": len(d["removed"]),
        # 原文段落一并返回：用户要能对回去核验，不能只看模型的转述
        "added": d["added"][:_MAX_SEND],
        "removed": d["removed"][:_MAX_SEND],
        "changeRatio": round(ratio, 3),
        "lowConfidence": suspect,
        "mode": "diff",
    }
    if suspect:
        result["reason"] = (
            f"这份申报里 {ratio:.0%} 的段落都被判为新增，远高于正常的逐年变化幅度，"
            f"多半是章节定位不准（SEC 文件排版没有统一标准）。"
            f"下面的比对结果仅供参考，建议直接点开原文核对。")

    if suspect or not use_llm or not (d["added"] or d["removed"]):
        return result

    try:
        import llm
        if not llm.available():
            result["llmError"] = llm.status().get("reason")
            return result
        gen = llm.summarize_risk_changes(
            sym, new_year, old_year, d["added"][:_MAX_SEND], d["removed"][:_MAX_SEND])
        if gen.get("ok"):
            result.update({
                "mode": "generative",
                "newRisks": gen["newRisks"],
                "droppedRisks": gen["droppedRisks"],
                "takeaway": gen["takeaway"],
                "provider": gen.get("provider"),
                "model": gen.get("model"),
                "usage": gen.get("usage"),
            })
        else:
            result["llmError"] = gen.get("reason")
    except Exception as exc:                          # noqa: BLE001
        result["llmError"] = f"{type(exc).__name__}: {exc}"

    return result
