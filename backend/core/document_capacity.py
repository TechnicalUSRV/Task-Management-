"""Conservative local capacity check; unknown RAM means one document slot."""
import ctypes
import os
from functools import lru_cache


def memory_bytes():
    if os.name == 'nt':
        class Memory(ctypes.Structure):
            _fields_ = [('length', ctypes.c_ulong), ('load', ctypes.c_ulong), *[(n, ctypes.c_ulonglong) for n in
                        ('total', 'available', 'page_total', 'page_available', 'virtual_total', 'virtual_available', 'extended')]]
        data = Memory()
        data.length = ctypes.sizeof(data)
        if ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(data)):
            return int(data.total)
        return 0
    try:
        return os.sysconf('SC_PHYS_PAGES') * os.sysconf('SC_PAGE_SIZE')
    except (ValueError, OSError, AttributeError):
        return 0


@lru_cache(maxsize=1)
def capacity():
    cores, ram = os.cpu_count() or 1, memory_bytes()
    # Conservative configuration ceiling, not a memory reservation or substitute for a server load test.
    ceiling = max(1, min(4, cores // 2, ram // (4 * 1024 ** 3))) if ram else 1
    try:
        requested = max(1, int(os.environ.get('DOCUMENT_WORKERS', '1')))
    except ValueError:
        requested = 1
    return {'logical_cpus': cores, 'ram_gb': round(ram / 1024 ** 3, 1), 'safe_ceiling': ceiling,
            'requested': requested, 'workers': min(requested, ceiling)}
