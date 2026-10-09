"""filing_text.py —— 10-K 正文抽取与逐年比对。

这个模块的价值全在"机械对比在本地做完"这一点上：
diff 结果是确定性的、可复算的、零成本的，LLM 只负责解读。
所以 diff 本身必须测透——它错了，模型解读得再好也是错的。
"""

import pytest

import filing_text as ft


# ----------------------------------------------------------------------
# HTML 清洗
# ----------------------------------------------------------------------

def test_strip_html_removes_tags_and_entities():
    out = ft._strip_html("<p>Risk&nbsp;&amp; reward</p>")
    assert "<p>" not in out
    assert "&nbsp;" not in out and "&amp;" not in out
    assert "Risk" in out and "reward" in out


def test_strip_html_drops_script_and_style():
    out = ft._strip_html(
        "<style>.a{color:red}</style><script>var x=1</script><p>正文</p>")
    assert "color:red" not in out and "var x" not in out
    assert "正文" in out


def test_strip_html_keeps_paragraph_boundaries():
    """段落边界是后面做 diff 的基本单位，丢了就全糊成一坨。"""
    out = ft._strip_html("<p>第一段</p><p>第二段</p>")
    assert "\n" in out
    assert len(ft.paragraphs(out, min_chars=2)) == 2


# ----------------------------------------------------------------------
# Item 1A 定位
# ----------------------------------------------------------------------

def _doc(risk_body, tail="Item 1B. Unresolved Staff Comments\nNone."):
    return f"Item 1. Business\nWe make chips.\n\nItem 1A. Risk Factors\n{risk_body}\n\n{tail}"


def test_extract_risk_factors_basic():
    body = "X " * 1500          # 够长，不会被当成目录项
    sec = ft.extract_risk_factors(_doc(body))
    assert sec is not None and "X" in sec
    assert "Unresolved Staff Comments" not in sec, "不该越界到 Item 1B"


def test_extract_skips_table_of_contents_entry():
    """目录里也写着 Item 1A. Risk Factors，但后面只跟页码。

    不处理的话会截出几十个字符的空壳，整个比对作废。
    """
    toc = "Item 1A. Risk Factors .......... 12\n"
    doc = toc + _doc("Y " * 1500)
    sec = ft.extract_risk_factors(doc)
    assert sec is not None and len(sec) > ft._MIN_SECTION_CHARS


def test_extract_falls_back_to_item_2():
    """有些公司没有 Item 1B，直接跳到 Item 2。"""
    sec = ft.extract_risk_factors(
        _doc("Z " * 1500, tail="Item 2. Properties\nOur HQ is in CA."))
    assert sec is not None
    assert "Our HQ" not in sec


@pytest.mark.parametrize("heading", [
    "Item 1A. Risk Factors",
    "ITEM 1A — RISK FACTORS",
    "Item 1A: Risk Factors",
    "Item  1A.   Risk  Factors",
])
def test_extract_tolerates_heading_variants(heading):
    """SEC 文件排版千奇百怪，标题匹配必须宽松。"""
    doc = f"Item 1. Business\nstuff\n\n{heading}\n" + "W " * 1500 + "\n\nItem 1B. Unresolved"
    assert ft.extract_risk_factors(doc) is not None


def test_extract_returns_none_when_absent():
    assert ft.extract_risk_factors("Item 1. Business\nNo risk section here.") is None


# ----------------------------------------------------------------------
# 段落切分
# ----------------------------------------------------------------------

def test_paragraphs_drops_short_fragments():
    text = "12\n\n" + ("A" * 200) + "\n\n短\n\n" + ("B" * 200)
    out = ft.paragraphs(text)
    assert len(out) == 2
    assert all(len(p) >= 120 for p in out)


def test_paragraphs_drops_page_numbers():
    text = "- 42 -\n\n" + ("C" * 200)
    assert len(ft.paragraphs(text)) == 1


def test_paragraphs_collapses_whitespace():
    out = ft.paragraphs("A  \n  B " + "x" * 200)
    assert "  " not in out[0] and "\n" not in out[0]


# ----------------------------------------------------------------------
# 归一化：数字变化不等于风险变化
# ----------------------------------------------------------------------

def test_normalize_erases_numbers():
    a = ft._normalize("In 2025 we had 3 factories and 45% share.")
    b = ft._normalize("In 2026 we had 5 factories and 51% share.")
    assert a == b, "只有年份金额变了，不该算成不同的风险"


def test_normalize_ignores_case_and_punctuation():
    assert ft._normalize("Supply-chain RISK!") == ft._normalize("supply chain risk")


# ----------------------------------------------------------------------
# 逐年 diff —— 核心
# ----------------------------------------------------------------------

P_SUPPLY = ("We depend on a limited number of third party foundries to "
            "manufacture our products and any disruption in their operations "
            "could materially harm our business and results of operations.")
P_COMPET = ("The markets for our products are intensely competitive and "
            "characterized by rapid technological change which could reduce "
            "our market share and adversely affect our operating results.")
P_AI_REG = ("New and evolving regulations governing artificial intelligence "
            "may restrict the sale of our products in certain jurisdictions "
            "and increase our compliance costs significantly.")


def test_identical_sections_produce_no_diff():
    d = ft.diff_sections([P_SUPPLY, P_COMPET], [P_SUPPLY, P_COMPET])
    assert d["added"] == [] and d["removed"] == []


def test_genuinely_new_paragraph_is_detected():
    d = ft.diff_sections([P_SUPPLY, P_COMPET], [P_SUPPLY, P_COMPET, P_AI_REG])
    assert len(d["added"]) == 1 and "artificial intelligence" in d["added"][0]
    assert d["removed"] == []


def test_dropped_paragraph_is_detected():
    d = ft.diff_sections([P_SUPPLY, P_COMPET], [P_SUPPLY])
    assert d["added"] == []
    assert len(d["removed"]) == 1 and "competitive" in d["removed"][0]


def test_reworded_paragraph_is_not_counted_as_new():
    """公司每年都微调措辞。逐字比对的话整章都算新增，这个功能就废了。"""
    reworded = P_SUPPLY.replace("limited number of", "small number of") \
                       .replace("materially harm", "seriously harm")
    d = ft.diff_sections([P_SUPPLY, P_COMPET], [reworded, P_COMPET])
    assert d["added"] == [], "小幅改写不该算新增风险"
    assert d["removed"] == []


def test_number_only_change_is_not_counted_as_new():
    old = "We operated 12 facilities in 2025 and spent $3.4 billion on research " \
          "and development activities across our global engineering organization."
    new = old.replace("12", "15").replace("2025", "2026").replace("3.4", "4.1")
    d = ft.diff_sections([old], [new])
    assert d["added"] == [] and d["removed"] == []


def test_reordering_does_not_create_diff():
    """公司常常调整风险因素的排列顺序，顺序变化不是内容变化。"""
    d = ft.diff_sections([P_SUPPLY, P_COMPET], [P_COMPET, P_SUPPLY])
    assert d["added"] == [] and d["removed"] == []


def test_merged_paragraphs_are_not_counted_as_new():
    """回归用例：公司把去年的两段合成今年的一段。

    这是逐段配对方案在真实年报上翻车的根因——一段对半段，
    相似度最高只有 0.5，调阈值救不回来。苹果 2024→2025 因此
    被报出 40% 的段落"新增"，里面全是每年必写的常规风险。
    """
    merged = P_SUPPLY + " " + P_COMPET
    d = ft.diff_sections([P_SUPPLY, P_COMPET], [merged])
    assert d["added"] == [], "合并段落不是新增内容"


def test_split_paragraphs_are_not_counted_as_new():
    """反方向：去年一段，今年拆成两段。"""
    merged = P_SUPPLY + " " + P_COMPET
    d = ft.diff_sections([merged], [P_SUPPLY, P_COMPET])
    assert d["added"] == [], "拆分段落不是新增内容"
    assert d["removed"] == []


def test_new_risk_survives_surrounding_restructure():
    """重点：段落结构大改的同时真的新增了一条，不能被一起放过。"""
    merged = P_SUPPLY + " " + P_COMPET
    d = ft.diff_sections([merged], [P_SUPPLY, P_COMPET, P_AI_REG])
    assert len(d["added"]) == 1
    assert "artificial intelligence" in d["added"][0]


def test_coverage_is_computed_against_whole_document():
    """覆盖率要拿整篇做底，不是单段——这正是能扛住重新切分的原因。"""
    pool = ft._shingles(P_SUPPLY) | ft._shingles(P_COMPET)
    assert ft._coverage(P_SUPPLY, pool) == 1.0
    assert ft._coverage(P_AI_REG, pool) < 0.3


def test_empty_inputs():
    assert ft.diff_sections([], []) == {"added": [], "removed": []}
    assert ft.diff_sections([], [P_SUPPLY])["added"] == [P_SUPPLY]
    assert ft.diff_sections([P_SUPPLY], [])["removed"] == [P_SUPPLY]


def test_threshold_is_tunable():
    reworded = P_SUPPLY.replace("limited number of", "small number of")
    assert ft.diff_sections([P_SUPPLY], [reworded], threshold=0.5)["added"] == []
    # 阈值拉到几乎要求逐字相同，就应该认成新增
    assert ft.diff_sections([P_SUPPLY], [reworded], threshold=0.999)["added"] != []


def test_shingles_handles_short_text():
    """短于 n 的段落退化成词集合，不能返回空集导致覆盖率恒为 1。"""
    assert ft._shingles("supply chain risk") == {"supply", "chain", "risk"}


# ----------------------------------------------------------------------
# 顶层流程的降级
# ----------------------------------------------------------------------

def test_risk_changes_needs_two_annual_reports(monkeypatch):
    monkeypatch.setattr(ft.research, "annual_reports", lambda s, count=2: {
        "found": True,
        "reports": [{"form": "10-K", "filingDate": "2026-02-01",
                     "reportDate": "2026-01-01",
                     "url": "https://example.com/a.htm"}]})
    out = ft.risk_changes("NVDA")
    assert out["found"] is False and "至少需要 2 份" in out["reason"]


def test_risk_changes_reports_missing_company(monkeypatch):
    monkeypatch.setattr(ft.research, "annual_reports", lambda s, count=2: {
        "found": False, "reason": "不在 SEC 登记名录中"})
    out = ft.risk_changes("NOPE")
    assert out["found"] is False and "SEC" in out["reason"]


def _two_filings(monkeypatch):
    monkeypatch.setattr(ft.research, "annual_reports", lambda s, count=2: {
        "found": True,
        "reports": [
            {"form": "10-K", "filingDate": "2026-02-20", "reportDate": "2026-01-25",
             "url": "https://example.com/new.htm"},
            {"form": "10-K", "filingDate": "2025-02-21", "reportDate": "2025-01-26",
             "url": "https://example.com/old.htm"}]})


def test_risk_changes_returns_diff_without_llm(monkeypatch):
    """LLM 不可用时照样给出 diff —— 少了解读，但原文段落都在。"""
    _two_filings(monkeypatch)
    pages = {
        "https://example.com/new.htm": _doc_html([P_SUPPLY, P_COMPET, P_AI_REG]),
        "https://example.com/old.htm": _doc_html([P_SUPPLY, P_COMPET]),
    }
    monkeypatch.setattr(ft.research, "_get_text", lambda url, timeout=60: pages[url])

    out = ft.risk_changes("NVDA", use_llm=False)
    assert out["found"] is True
    assert out["mode"] == "diff"
    assert out["addedCount"] == 1
    assert "artificial intelligence" in out["added"][0]
    assert out["newFiling"]["year"] == "2026"
    assert out["oldFiling"]["year"] == "2025"
    # 原文链接要带上，用户得能点回去核验
    assert out["newFiling"]["url"].endswith("new.htm")


def test_risk_changes_surfaces_llm_failure(monkeypatch):
    _two_filings(monkeypatch)
    # 真实年报大部分段落逐年不变，只有少数新增。夹具要像这样，
    # 否则新增占比过高会被可信度守卫拦下，走不到调用模型那一步。
    shared = [P_SUPPLY] + [_unique_para(3000 + k) for k in range(8)]
    pages = {
        "https://example.com/new.htm": _doc_html(shared + [P_AI_REG]),
        "https://example.com/old.htm": _doc_html(shared),
    }
    monkeypatch.setattr(ft.research, "_get_text", lambda url, timeout=60: pages[url])

    out = ft.risk_changes("NVDA", use_llm=True)     # 测试环境没有 Key
    assert out["lowConfidence"] is False
    assert out["found"] is True and out["mode"] == "diff"
    assert out.get("llmError"), "LLM 不可用时要把原因带出来，而不是静默"


def test_risk_changes_handles_missing_section(monkeypatch):
    _two_filings(monkeypatch)
    monkeypatch.setattr(ft.research, "_get_text",
                        lambda url, timeout=60: "<p>Item 1. Business only</p>")
    out = ft.risk_changes("NVDA", use_llm=False)
    assert out["found"] is False and "Item 1A" in out["reason"]


def test_risk_changes_handles_download_failure(monkeypatch):
    _two_filings(monkeypatch)

    def boom(url, timeout=60):
        raise RuntimeError("503 from SEC")

    monkeypatch.setattr(ft.research, "_get_text", boom)
    out = ft.risk_changes("NVDA", use_llm=False)
    assert out["found"] is False and "503" in out["reason"]


def _doc_html(paras):
    body = "".join(f"<p>{p}</p>" for p in paras)
    return ("<html><body><p>Item 1. Business</p><p>We make chips.</p>"
            "<p>Item 1A. Risk Factors</p>" + body + "<p>" + ("padding text here. " * 200) + "</p>"
            "<p>Item 1B. Unresolved Staff Comments</p><p>None.</p></body></html>")

def test_implausible_diff_is_flagged_not_presented(monkeypatch):
    """回归用例：章节定位偏了会表现为"几乎全是新增"。

    实测 8 家公司里有 2 家会这样（一家 20-F、一家申报量极大的银行）。
    这种结果既没用又会摧毁信任，必须自己识别出来并说明，
    而不是当成洞察端出去。同时要跳过模型调用——错输入生成的解读是白花钱。
    """
    _two_filings(monkeypatch)
    # 两组用词必须真正无关，否则共享的套话会撑高覆盖率
    old_paras = [f"Hydroelectric turbine maintenance schedules in the northern "
                 f"province require seasonal inspection cycles numbered {i} "
                 f"under municipal water authority supervision guidelines."
                 for i in range(10)]
    new_paras = [f"Quantum cryptography research grants allocated toward "
                 f"photonic lattice experiments batch {i} await peer review "
                 f"from independent academic consortium members abroad."
                 for i in range(10)]
    pages = {"https://example.com/new.htm": _doc_html(new_paras),
             "https://example.com/old.htm": _doc_html(old_paras)}
    monkeypatch.setattr(ft.research, "_get_text", lambda url, timeout=60: pages[url])

    called = []
    import llm
    monkeypatch.setattr(llm, "available", lambda: called.append(1) or True)

    out = ft.risk_changes("NVDA", use_llm=True)
    assert out["found"] is True
    assert out["lowConfidence"] is True
    assert out["changeRatio"] > 0.6
    assert "仅供参考" in out["reason"]
    assert not called, "可信度存疑时不该再去调模型"


def test_normal_diff_is_not_flagged(monkeypatch):
    """反向验证：正常幅度的变化不能被误标成不可信。"""
    _two_filings(monkeypatch)
    # 共享段落必须长于 paragraphs() 的 120 字符门槛。最初这里每段只有
    # 约 112 个字符，全被静默过滤掉，实际只剩"1 新 1 旧"——比例 50%。
    # 阈值是 0.6 时恰好没暴露，调到 0.3 才露出来。
    base = [_unique_para(2000 + k) for k in range(10)]
    pages = {"https://example.com/new.htm": _doc_html(base + [P_AI_REG]),
             "https://example.com/old.htm": _doc_html(base)}
    monkeypatch.setattr(ft.research, "_get_text", lambda url, timeout=60: pages[url])

    out = ft.risk_changes("NVDA", use_llm=False)
    assert out["lowConfidence"] is False
    assert out["addedCount"] == 1

# ----------------------------------------------------------------------
# 可信度阈值
# ----------------------------------------------------------------------

def _word(n):
    """确定性地生成一个纯字母"词"。

    不能用数字区分：_normalize 会把数字全抹成 #，"risk1" 和 "risk2"
    归一化后是同一个词，覆盖率会被虚高。
    """
    out, n = "", n + 1000
    while n:
        out += chr(97 + n % 26)
        n //= 26
    return out


def _unique_para(i):
    """词汇和其他任何段落都不重叠的段落。"""
    return " ".join(_word(i * 100 + j) for j in range(30)) + "."


@pytest.mark.parametrize("new_count,flagged", [
    (2, False),    # 2 / 10 = 20%，相当于 MSFT 的 19.6%
    (4, True),     # 4 / 12 = 33%，越过 0.3
])
def test_threshold_boundary(monkeypatch, new_count, flagged):
    _two_filings(monkeypatch)
    base = [_unique_para(1000 + k) for k in range(8)]
    fresh = [_unique_para(k) for k in range(new_count)]
    pages = {"https://example.com/new.htm": _doc_html(base + fresh),
             "https://example.com/old.htm": _doc_html(base)}
    monkeypatch.setattr(ft.research, "_get_text", lambda url, timeout=60: pages[url])

    out = ft.risk_changes("NVDA", use_llm=False)
    assert out["addedCount"] == new_count
    assert out["lowConfidence"] is flagged


def test_threshold_sits_between_measured_normal_and_rewrite():
    """阈值的依据是实测数据，钉在这里防止以后被随手改掉。

    6 家正常公司的新增占比最高是 MSFT 的 19.6%；JPM 大幅改写措辞后是 43.8%。
    阈值必须落在两者之间：太低会把正常结果误标成不可信，太高（比如最初的 0.6）
    会让 JPM 这种文字新、概念旧的结果被当成正常结论端出去。
    """
    assert 0.196 < ft._SUSPECT_RATIO < 0.438


def test_flag_reason_names_both_causes(monkeypatch):
    """提示语要把两种原因都说出来——大幅改写和章节定位不准是不同的问题。"""
    _two_filings(monkeypatch)
    pages = {"https://example.com/new.htm": _doc_html([_unique_para(k) for k in range(10)]),
             "https://example.com/old.htm": _doc_html([_unique_para(500 + k) for k in range(10)])}
    monkeypatch.setattr(ft.research, "_get_text", lambda url, timeout=60: pages[url])

    reason = ft.risk_changes("NVDA", use_llm=False)["reason"]
    assert "改写" in reason
    assert "定位" in reason
    assert "仅供参考" in reason

