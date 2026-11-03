"""Эффект стекла для окна Windows 10/11: размытие фона и полупрозрачность.

Работает только на Windows. На других системах и при любой ошибке молча ничего не делает,
окно остаётся обычным.
"""
from __future__ import annotations

import ctypes
import sys

KEY_COLOR = "#010203"  # этот цвет окно считает прозрачным: сквозь него видно размытый фон
MODES = ("off", "mica", "acrylic", "blur")
MODE_TITLES = {"off": "Выкл", "mica": "Mica (Windows 11)", "acrylic": "Acrylic (стекло)", "blur": "Размытие (Windows 10)"}


class _Accent(ctypes.Structure):
    _fields_ = [("AccentState", ctypes.c_int), ("AccentFlags", ctypes.c_int),
                ("GradientColor", ctypes.c_uint), ("AnimationId", ctypes.c_int)]


class _CompositionData(ctypes.Structure):
    _fields_ = [("Attribute", ctypes.c_int), ("Data", ctypes.c_void_p), ("SizeOfData", ctypes.c_size_t)]


class _Margins(ctypes.Structure):
    _fields_ = [("l", ctypes.c_int), ("r", ctypes.c_int), ("t", ctypes.c_int), ("b", ctypes.c_int)]


def supported() -> bool:
    return sys.platform == "win32"


def _hwnd(window) -> int:
    window.update_idletasks()
    return ctypes.windll.user32.GetParent(window.winfo_id()) or window.winfo_id()


def _accent(hwnd: int, state: int, tint_abgr: int) -> None:
    policy = _Accent(state, 2, tint_abgr, 0)
    data = _CompositionData(19, ctypes.cast(ctypes.pointer(policy), ctypes.c_void_p), ctypes.sizeof(policy))
    ctypes.windll.user32.SetWindowCompositionAttribute(hwnd, ctypes.byref(data))


def apply(window, mode: str, dark: bool, alpha: float) -> bool:
    """Включить эффект. Возвращает True, если применено. mode: off | mica | acrylic | blur."""
    if not supported():
        return False
    try:
        hwnd = _hwnd(window)
        dwm = ctypes.windll.dwmapi
        dwm.DwmSetWindowAttribute(hwnd, 20, ctypes.byref(ctypes.c_int(1 if dark else 0)), 4)  # тёмная рамка
        if mode == "off":
            dwm.DwmSetWindowAttribute(hwnd, 38, ctypes.byref(ctypes.c_int(1)), 4)  # без подложки
            _accent(hwnd, 0, 0)
            window.wm_attributes("-transparentcolor", "")
            window.wm_attributes("-alpha", 1.0)
            return False
        # цвет подложки AABBGGRR: тёмная или светлая лёгкая тонировка
        tint = 0x99181410 if dark else 0x99F4F0EC
        if mode == "mica":
            dwm.DwmExtendFrameIntoClientArea(hwnd, ctypes.byref(_Margins(-1, -1, -1, -1)))
            dwm.DwmSetWindowAttribute(hwnd, 38, ctypes.byref(ctypes.c_int(2)), 4)
        elif mode == "acrylic":
            dwm.DwmExtendFrameIntoClientArea(hwnd, ctypes.byref(_Margins(-1, -1, -1, -1)))
            try:
                dwm.DwmSetWindowAttribute(hwnd, 38, ctypes.byref(ctypes.c_int(3)), 4)  # Windows 11 22H2+
            except Exception:  # noqa: BLE001
                pass
            _accent(hwnd, 4, tint)  # Windows 10 1803+
        else:
            _accent(hwnd, 3, tint)
        window.wm_attributes("-transparentcolor", KEY_COLOR)
        # общая прозрачность делает текст пиксельным, поэтому включается только по просьбе (меньше 100%)
        window.wm_attributes("-alpha", max(0.7, min(1.0, alpha)))
        return True
    except Exception:  # noqa: BLE001
        return False
