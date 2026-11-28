#include "guard.h"

/* Compare sums on both sides, as Knot.fails does. The largest sum of two
 * uint32_t inputs is 2^33 - 2, including for a transfer that exceeds stock. */
static inline unsigned limit_bits(uint32_t balance, uint32_t incoming,
                                  uint32_t outgoing, uint32_t minimum,
                                  uint32_t maximum, uint32_t committed,
                                  unsigned floor_bit, unsigned ceiling_bit)
{
    const uint32_t reserved = minimum > committed ? minimum : committed;
    const uint64_t available = (uint64_t)balance + incoming;
    const uint64_t lower = (uint64_t)outgoing + reserved;
    const uint64_t upper = (uint64_t)outgoing + maximum;
    return (available < lower ? floor_bit : 0u) |
           (available > upper ? ceiling_bit : 0u);
}

static inline uint8_t row_mask(const uint32_t *row)
{
    const unsigned closed = row[KNOT_CLOSED] == 1u ? KNOT_FAIL_CLOSED : 0u;
    const unsigned locked = row[KNOT_LOCKED] == 1u &&
                            (row[KNOT_BUDGET_OUT] != 0u || row[KNOT_HOURS_OUT] != 0u)
                            ? KNOT_FAIL_LOCKED : 0u;
    const unsigned budget = limit_bits(row[KNOT_BUDGET], row[KNOT_BUDGET_IN],
                                       row[KNOT_BUDGET_OUT], row[KNOT_MIN_BUDGET],
                                       row[KNOT_MAX_BUDGET], row[KNOT_COMMITTED_BUDGET],
                                       KNOT_FAIL_BUDGET_FLOOR, KNOT_FAIL_BUDGET_CEILING);
    const unsigned hours = limit_bits(row[KNOT_HOURS], row[KNOT_HOURS_IN],
                                      row[KNOT_HOURS_OUT], row[KNOT_MIN_HOURS],
                                      row[KNOT_MAX_HOURS], row[KNOT_COMMITTED_HOURS],
                                      KNOT_FAIL_HOURS_FLOOR, KNOT_FAIL_HOURS_CEILING);
    return (uint8_t)(closed | locked | budget | hours);
}

uint8_t knot_word_mask(const uint32_t row[KNOT_ROW_WORDS])
{
    return row_mask(row);
}

void knot_word_masks(const uint32_t *rows, size_t count, uint8_t *out)
{
    for (size_t i = 0; i < count; ++i) {
        out[i] = row_mask(rows);
        rows += KNOT_ROW_WORDS;
    }
}

uint16_t knot_transfer_masks(uint32_t donor_budget, uint32_t donor_hours,
                             uint32_t recipient_budget, uint32_t recipient_hours,
                             uint32_t budget, uint32_t hours,
                             uint32_t min_budget, uint32_t min_hours,
                             uint32_t max_budget, uint32_t max_hours)
{
    const unsigned donor =
        limit_bits(donor_budget, 0, budget, min_budget, max_budget, min_budget,
                   KNOT_FAIL_BUDGET_FLOOR, KNOT_FAIL_BUDGET_CEILING) |
        limit_bits(donor_hours, 0, hours, min_hours, max_hours, min_hours,
                   KNOT_FAIL_HOURS_FLOOR, KNOT_FAIL_HOURS_CEILING);
    const unsigned recipient =
        limit_bits(recipient_budget, budget, 0, min_budget, max_budget, min_budget,
                   KNOT_FAIL_BUDGET_FLOOR, KNOT_FAIL_BUDGET_CEILING) |
        limit_bits(recipient_hours, hours, 0, min_hours, max_hours, min_hours,
                   KNOT_FAIL_HOURS_FLOOR, KNOT_FAIL_HOURS_CEILING);
    return (uint16_t)(donor | (recipient << 8));
}
