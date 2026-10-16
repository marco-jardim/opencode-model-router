import os

import mypkg


def test_imports_the_slot_copy():
    here = os.path.normcase(os.path.realpath(os.getcwd()))
    module = os.path.normcase(os.path.realpath(mypkg.__file__))
    print("MODULE_PATH=" + mypkg.__file__)
    assert module.startswith(here + os.sep), f"{module} is not under {here}"
    assert mypkg.VALUE == 1
