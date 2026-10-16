from mypkg import total


def test_total_includes_every_value():
    assert total([2, 3, 5]) == 10


def test_empty_total_is_the_additive_identity():
    assert total([]) == 0
