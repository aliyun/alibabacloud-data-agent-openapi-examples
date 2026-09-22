from das_python.marker import strip_marker_instruction


def test_legacy_six_digit_marker_instruction_is_removed():
    text = "问题\n\n（本轮校验码 DAS-C0FFEE：请在回答的第一行原样输出这个校验码，不要改写、不要翻译、不要解释它。）"
    assert strip_marker_instruction(text) == "问题"


def test_similar_user_text_is_preserved():
    text = "请说明（本轮校验码是什么意思）"
    assert strip_marker_instruction(text) == text
    assert strip_marker_instruction("（本轮校验码 DAS-ABCD：测试）") == "（本轮校验码 DAS-ABCD：测试）"
