"""Use the fixed-word guard while preserving the ERP adapter's Python contract."""

import ctypes
from pathlib import Path

import policy_gate

WORD_LIMIT = (1 << 32) - 1
RULE_ORDER = ('closed', 'locked', 'budget-floor', 'hours-floor', 'budget-ceiling', 'hours-ceiling')


class NativeGuard:
    def __init__(self, library_path):
        if tuple(rule['code'] for rule in policy_gate.rules()) != RULE_ORDER:
            raise RuntimeError('The native mask does not match the frozen policy rule order')
        self.library = ctypes.CDLL(str(Path(library_path).resolve(strict=True)))
        self._transfer = self.library.knot_transfer_masks
        self._transfer.argtypes = [ctypes.c_uint32] * 10
        self._transfer.restype = ctypes.c_uint16
        self._batch = self.library.knot_word_masks
        self._batch.argtypes = [ctypes.POINTER(ctypes.c_uint32), ctypes.c_size_t,
                                ctypes.POINTER(ctypes.c_uint8)]
        self._batch.restype = None

    def batch_masks(self, rows, count, output):
        if (type(count) is not int or count < 0 or len(rows) != 14 * count
                or len(output) != count):
            raise ValueError('Expected 14 contiguous uint32 values and one output byte per row')
        self._batch(rows, count, output)

    def check_transfer(self, donor, recipient, budget, hours):
        max_amount = policy_gate.MAX_AMOUNT
        if (len(donor) != 2 or len(recipient) != 2
                or any(type(v) is not int or not 0 <= v <= max_amount for v in (*donor, *recipient))):
            raise ValueError('Expected two nonnegative, bounded integer balances per account')
        if type(budget) is not int or type(hours) is not int or min(budget, hours) <= 0:
            raise ValueError('Transfer amount and effort must be positive integers')
        if budget > WORD_LIMIT or hours > WORD_LIMIT:
            return policy_gate.check_transfer(donor, recipient, budget, hours)

        masks = self._transfer(*donor, *recipient, budget, hours,
                               policy_gate.MIN_BUDGET, policy_gate.MIN_HOURS, max_amount, max_amount)
        accepted = masks == 0
        failures = {'donor': [], 'recipient': []}
        if not accepted:
            for bit, rule in enumerate(RULE_ORDER):
                if masks & (1 << bit):
                    failures['donor'].append(rule)
                if masks & (1 << (bit + 8)):
                    failures['recipient'].append(rule)
        return {
            'accepted': accepted,
            'reasons': failures,
            'donorAfter': [donor[0] - budget, donor[1] - hours] if accepted else list(donor),
            'recipientAfter': [recipient[0] + budget, recipient[1] + hours] if accepted else list(recipient),
        }
