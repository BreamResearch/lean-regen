#ifndef KNOT_NATIVE_GUARD_H
#define KNOT_NATIVE_GUARD_H

#include <stddef.h>
#include <stdint.h>

/* The row layout follows Knot.Field. Encode the last two Bool fields as 0 or 1. */
enum knot_word_field {
    KNOT_BUDGET, KNOT_HOURS, KNOT_BUDGET_IN, KNOT_HOURS_IN,
    KNOT_BUDGET_OUT, KNOT_HOURS_OUT, KNOT_MIN_BUDGET, KNOT_MIN_HOURS,
    KNOT_MAX_BUDGET, KNOT_MAX_HOURS, KNOT_COMMITTED_BUDGET, KNOT_COMMITTED_HOURS,
    KNOT_CLOSED, KNOT_LOCKED, KNOT_ROW_WORDS
};

enum knot_reason {
    KNOT_FAIL_CLOSED = 1u << 0,
    KNOT_FAIL_LOCKED = 1u << 1,
    KNOT_FAIL_BUDGET_FLOOR = 1u << 2,
    KNOT_FAIL_HOURS_FLOOR = 1u << 3,
    KNOT_FAIL_BUDGET_CEILING = 1u << 4,
    KNOT_FAIL_HOURS_CEILING = 1u << 5
};

uint8_t knot_word_mask(const uint32_t row[KNOT_ROW_WORDS]);

/* Supply count consecutive rows and count nonoverlapping output bytes.
 * With count zero, the pointers may be null. */
void knot_word_masks(const uint32_t *rows, size_t count, uint8_t *out);

/* The Odoo adapter uses open, unlocked accounts with commitments equal to
 * their minima. Bits 0..5 report the donor's violations, bits 8..13 the
 * recipient's. Callers validate transfer input before converting to words. */
uint16_t knot_transfer_masks(uint32_t donor_budget, uint32_t donor_hours,
                             uint32_t recipient_budget, uint32_t recipient_hours,
                             uint32_t budget, uint32_t hours,
                             uint32_t min_budget, uint32_t min_hours,
                             uint32_t max_budget, uint32_t max_hours);

#endif
