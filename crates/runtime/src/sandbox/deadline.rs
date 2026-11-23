use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Instant;

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
        *self.started.lock().expect("deadline clock poisoned") = Instant::now();
        self.budget_us
            .store(ms.saturating_mul(1000), Ordering::Relaxed);
    }

    pub(super) fn disarm(&self) {
        self.budget_us.store(u64::MAX, Ordering::Relaxed);
    }

    pub(super) fn expired(&self) -> bool {
        let budget = self.budget_us.load(Ordering::Relaxed);
        if budget == u64::MAX {
            return false;
        }
        let elapsed = self
            .started
            .lock()
            .expect("deadline clock poisoned")
            .elapsed();
        elapsed.as_micros() >= u128::from(budget)
    }
}
