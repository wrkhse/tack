use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Instant;

#[derive(Debug)]
pub(super) struct Deadline {
    started: Mutex<Instant>,
    budget_us: AtomicU64,
}

impl Deadline {
    pub(super) fn new() -> Self {
        Self {
            started: Mutex::new(Instant::now()),
            budget_us: AtomicU64::new(u64::MAX),
        }
    }

    pub(super) fn begin(&self, ms: u64) {
        let Ok(mut started) = self.started.lock() else {
            // A poisoned clock cannot time a call. Arm an already-expired
            // budget so the interrupt denies with the named deadline limit.
            self.budget_us.store(0, Ordering::Relaxed);
            return;
        };

        *started = Instant::now();
        self.budget_us
            .store(ms.saturating_mul(1000).min(u64::MAX - 1), Ordering::Relaxed);
    }

    pub(super) fn disarm(&self) {
        self.budget_us.store(u64::MAX, Ordering::Relaxed);
    }

    pub(super) fn expired(&self) -> bool {
        let budget = self.budget_us.load(Ordering::Relaxed);
        if budget == u64::MAX {
            return false;
        }
        let Ok(started) = self.started.lock() else {
            // Fail closed: a poisoned clock becomes a named deadline deny.
            return true;
        };

        started.elapsed().as_micros() >= u128::from(budget)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn begin_arms_a_budget_and_disarm_clears_it() {
        let deadline = Deadline::new();
        assert!(!deadline.expired(), "a fresh clock has no budget");

        deadline.begin(0);
        assert!(deadline.expired(), "a zero budget is immediately expired");

        deadline.disarm();
        assert!(!deadline.expired(), "disarming clears the budget");
    }

    #[test]
    fn a_saturated_budget_stays_below_the_disarmed_sentinel() {
        let deadline = Deadline::new();
        deadline.begin(u64::MAX);

        assert_eq!(deadline.budget_us.load(Ordering::Relaxed), u64::MAX - 1);
    }
}
