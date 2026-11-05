//! AgentGuard policy contract (v2: swarm mode + pending approvals).
//!
//! A human ("owner") funds a shared policy vault (a "swarm"). One or more AI
//! agent accounts are members of that swarm. Each agent holds only a
//! function-call access key scoped to this contract, so the only way it can
//! move money is `execute_transfer` / `request_transfer`, which enforce:
//!   * a shared, evidence-backed blocklist (community `report()` + guardian confirm)
//!   * the owner's per-swarm blocklist and optional allowlist
//!   * shared per-transaction and rolling UTC-day caps on the swarm vault
//!   * per-agent per-transaction and daily caps on top of the shared caps
//! Medium-risk payments can be parked as on-chain pendings for the owner to
//! approve or reject. Rejected attempts are recorded as incidents.

use near_sdk::json_types::U128;
use near_sdk::store::{IterableMap, LookupMap};
use near_sdk::{
    env, log, near, require, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise,
    PromiseError,
};

const NANOS_PER_DAY: u64 = 86_400_000_000_000;
const MAX_EVIDENCE_LEN: usize = 1024;
const MAX_REASON_LEN: usize = 256;
const MAX_LIST_LEN: usize = 100;
const MAX_INCIDENTS_PER_SWARM: usize = 50;
const MAX_REPORTS_PER_ACCOUNT: usize = 20;
const MAX_AGENTS_PER_SWARM: usize = 32;
const MAX_SWARM_ID_LEN: usize = 64;
const CALLBACK_GAS: Gas = Gas::from_tgas(10);

#[derive(BorshStorageKey)]
#[near]
enum StorageKey {
    Swarms,
    Agents,
    Reports,
    Guardians,
    GlobalBlock,
    Pendings,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Swarm {
    pub owner: AccountId,
    pub balance: U128,
    pub per_tx_cap: U128,
    pub daily_cap: U128,
    pub spent_today: U128,
    pub day_index: u64,
    pub allowlist: Vec<AccountId>,
    pub blocklist: Vec<AccountId>,
    pub paused: bool,
    pub total_sent: U128,
    pub tx_count: u64,
    pub blocked_count: u64,
    pub incidents: Vec<Incident>,
    pub members: Vec<AccountId>,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct AgentMember {
    pub swarm_id: String,
    pub per_tx_cap: U128,
    pub daily_cap: U128,
    pub spent_today: U128,
    pub day_index: u64,
    pub paused: bool,
}

/// Backward-compatible agent view: swarm vault + this agent's own caps/spend.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Policy {
    pub owner: AccountId,
    pub balance: U128,
    pub per_tx_cap: U128,
    pub daily_cap: U128,
    pub spent_today: U128,
    pub day_index: u64,
    pub allowlist: Vec<AccountId>,
    pub blocklist: Vec<AccountId>,
    pub paused: bool,
    pub total_sent: U128,
    pub tx_count: u64,
    pub blocked_count: u64,
    pub incidents: Vec<Incident>,
    pub swarm_id: String,
    pub agent_per_tx_cap: U128,
    pub agent_daily_cap: U128,
    pub agent_spent_today: U128,
    pub members: Vec<AccountId>,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Incident {
    pub receiver: AccountId,
    pub amount: U128,
    pub reason: String,
    pub memo: String,
    pub timestamp_ms: u64,
    pub agent_id: Option<AccountId>,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Report {
    pub reporter: AccountId,
    pub evidence: String,
    pub timestamp_ms: u64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct GlobalBlock {
    pub reason: String,
    pub confirmed_by: AccountId,
    pub timestamp_ms: u64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct PendingTransfer {
    pub id: u64,
    pub agent_id: AccountId,
    pub swarm_id: String,
    pub receiver_id: AccountId,
    pub amount: U128,
    pub memo: String,
    pub reason: String,
    pub timestamp_ms: u64,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct TransferOutcome {
    pub ok: bool,
    pub status: String,
    pub reason: String,
    pub pending_id: Option<u64>,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct ReceiverStatus {
    pub globally_blocked: bool,
    pub block_reason: Option<String>,
    pub report_count: u32,
    pub distinct_reporters: u32,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Config {
    pub admin: AccountId,
    pub report_threshold: u32,
    pub guardians: Vec<AccountId>,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct AgentGuard {
    admin: AccountId,
    guardians: IterableMap<AccountId, ()>,
    swarms: IterableMap<String, Swarm>,
    agents: IterableMap<AccountId, AgentMember>,
    reports: LookupMap<AccountId, Vec<Report>>,
    global_block: IterableMap<AccountId, GlobalBlock>,
    pendings: IterableMap<u64, PendingTransfer>,
    next_pending_id: u64,
    report_threshold: u32,
}

fn now_ms() -> u64 {
    env::block_timestamp_ms()
}
fn today() -> u64 {
    env::block_timestamp() / NANOS_PER_DAY
}
fn emit(event: &str, data: near_sdk::serde_json::Value) {
    let ev = near_sdk::serde_json::json!({
        "standard": "agentguard", "version": "2.0.0", "event": event, "data": [data]
    });
    log!("EVENT_JSON:{}", ev);
}
fn outcome(ok: bool, status: &str, reason: impl Into<String>, pending_id: Option<u64>) -> TransferOutcome {
    TransferOutcome { ok, status: status.into(), reason: reason.into(), pending_id }
}
fn valid_swarm_id(id: &str) {
    require!(!id.is_empty() && id.len() <= MAX_SWARM_ID_LEN, "invalid swarm_id");
}

#[near]
impl AgentGuard {
    #[init]
    pub fn new(admin: AccountId, report_threshold: Option<u32>) -> Self {
        let mut s = Self {
            admin: admin.clone(),
            guardians: IterableMap::new(StorageKey::Guardians),
            swarms: IterableMap::new(StorageKey::Swarms),
            agents: IterableMap::new(StorageKey::Agents),
            reports: LookupMap::new(StorageKey::Reports),
            global_block: IterableMap::new(StorageKey::GlobalBlock),
            pendings: IterableMap::new(StorageKey::Pendings),
            next_pending_id: 1,
            report_threshold: report_threshold.unwrap_or(3).max(1),
        };
        s.guardians.insert(admin, ());
        s
    }

    // ---------------- admin / guardians ----------------
    pub fn add_guardian(&mut self, account_id: AccountId) {
        self.assert_admin();
        self.guardians.insert(account_id, ());
    }
    pub fn remove_guardian(&mut self, account_id: AccountId) {
        self.assert_admin();
        require!(account_id != self.admin, "cannot remove admin");
        self.guardians.remove(&account_id);
    }
    pub fn confirm_block(&mut self, account_id: AccountId, reason: String) {
        self.assert_guardian();
        require!(reason.len() <= MAX_REASON_LEN, "reason too long");
        self.global_block.insert(
            account_id.clone(),
            GlobalBlock { reason: reason.clone(), confirmed_by: env::predecessor_account_id(), timestamp_ms: now_ms() },
        );
        emit("global_block", near_sdk::serde_json::json!({"account_id": account_id, "reason": reason}));
    }
    pub fn unblock(&mut self, account_id: AccountId) {
        self.assert_guardian();
        self.global_block.remove(&account_id);
        self.reports.remove(&account_id);
        emit("global_unblock", near_sdk::serde_json::json!({"account_id": account_id}));
    }

    // ---------------- community reports ----------------
    pub fn report(&mut self, account_id: AccountId, evidence: String) -> ReceiverStatus {
        require!(!evidence.trim().is_empty(), "evidence required");
        require!(evidence.len() <= MAX_EVIDENCE_LEN, "evidence too long");
        let reporter = env::predecessor_account_id();
        require!(reporter != account_id, "cannot report yourself");
        let mut list = self.reports.get(&account_id).cloned().unwrap_or_default();
        require!(!list.iter().any(|r| r.reporter == reporter), "already reported by you");
        require!(list.len() < MAX_REPORTS_PER_ACCOUNT, "report list full");
        list.push(Report { reporter: reporter.clone(), evidence: evidence.clone(), timestamp_ms: now_ms() });
        let distinct = list.len() as u32;
        self.reports.insert(account_id.clone(), list);
        emit("report", near_sdk::serde_json::json!({"account_id": account_id, "reporter": reporter, "evidence": evidence}));
        let is_guardian = self.guardians.contains_key(&reporter);
        if (distinct >= self.report_threshold || is_guardian) && !self.global_block.contains_key(&account_id) {
            let reason = if is_guardian { format!("guardian report: {}", evidence) } else { format!("{} community reports", distinct) };
            let reason: String = reason.chars().take(MAX_REASON_LEN).collect();
            self.global_block.insert(account_id.clone(), GlobalBlock { reason: reason.clone(), confirmed_by: reporter, timestamp_ms: now_ms() });
            emit("global_block", near_sdk::serde_json::json!({"account_id": account_id, "reason": reason}));
        }
        self.receiver_status(account_id)
    }

    // ---------------- swarm + agent registration ----------------
    /// Create a swarm vault. Caller becomes the owner. Agents are added with `add_agent`.
    #[payable]
    pub fn register_swarm(
        &mut self,
        swarm_id: String,
        per_tx_cap: U128,
        daily_cap: U128,
        allowlist: Option<Vec<AccountId>>,
    ) -> Swarm {
        valid_swarm_id(&swarm_id);
        require!(!self.swarms.contains_key(&swarm_id), "swarm already registered");
        require!(per_tx_cap.0 > 0 && daily_cap.0 > 0, "caps must be > 0");
        require!(per_tx_cap.0 <= daily_cap.0, "per_tx_cap must be <= daily_cap");
        let allowlist = allowlist.unwrap_or_default();
        require!(allowlist.len() <= MAX_LIST_LEN, "allowlist too long");
        let s = Swarm {
            owner: env::predecessor_account_id(),
            balance: U128(env::attached_deposit().as_yoctonear()),
            per_tx_cap,
            daily_cap,
            spent_today: U128(0),
            day_index: today(),
            allowlist,
            blocklist: vec![],
            paused: false,
            total_sent: U128(0),
            tx_count: 0,
            blocked_count: 0,
            incidents: vec![],
            members: vec![],
        };
        self.swarms.insert(swarm_id.clone(), s.clone());
        emit("register_swarm", near_sdk::serde_json::json!({"swarm_id": swarm_id, "owner": s.owner}));
        s
    }

    /// Owner adds an agent account to a swarm with its own per-tx / daily caps
    /// (must be <= the swarm's shared caps).
    pub fn add_agent(
        &mut self,
        swarm_id: String,
        agent_id: AccountId,
        per_tx_cap: U128,
        daily_cap: U128,
    ) -> AgentMember {
        require!(!self.agents.contains_key(&agent_id), "agent already registered");
        let owner = env::predecessor_account_id();
        let swarm = self.swarms.get_mut(&swarm_id).unwrap_or_else(|| env::panic_str("unknown swarm"));
        require!(swarm.owner == owner, "owner only");
        require!(swarm.members.len() < MAX_AGENTS_PER_SWARM, "swarm full");
        require!(per_tx_cap.0 > 0 && daily_cap.0 > 0, "caps must be > 0");
        require!(per_tx_cap.0 <= daily_cap.0, "per_tx_cap must be <= daily_cap");
        require!(per_tx_cap.0 <= swarm.per_tx_cap.0, "agent per_tx_cap exceeds swarm");
        require!(daily_cap.0 <= swarm.daily_cap.0, "agent daily_cap exceeds swarm");
        swarm.members.push(agent_id.clone());
        let m = AgentMember {
            swarm_id: swarm_id.clone(),
            per_tx_cap,
            daily_cap,
            spent_today: U128(0),
            day_index: today(),
            paused: false,
        };
        self.agents.insert(agent_id.clone(), m.clone());
        emit("add_agent", near_sdk::serde_json::json!({"swarm_id": swarm_id, "agent_id": agent_id}));
        m
    }

    /// Owner removes an agent from its swarm. Pending transfers for that agent are rejected.
    pub fn remove_agent(&mut self, agent_id: AccountId) {
        let m = self.agents.get(&agent_id).cloned().unwrap_or_else(|| env::panic_str("unknown agent"));
        let swarm = self.swarms.get_mut(&m.swarm_id).unwrap_or_else(|| env::panic_str("unknown swarm"));
        require!(swarm.owner == env::predecessor_account_id(), "owner only");
        swarm.members.retain(|a| a != &agent_id);
        self.agents.remove(&agent_id);
        // drop open pendings for this agent
        let drop: Vec<u64> = self.pendings.iter().filter(|(_, p)| p.agent_id == agent_id).map(|(k, _)| *k).collect();
        for id in drop {
            self.pendings.remove(&id);
        }
        emit("remove_agent", near_sdk::serde_json::json!({"swarm_id": m.swarm_id, "agent_id": agent_id}));
    }

    /// Convenience: register a one-agent swarm named after the agent (v1-compatible).
    #[payable]
    pub fn register_agent(
        &mut self,
        agent_id: AccountId,
        per_tx_cap: U128,
        daily_cap: U128,
        allowlist: Option<Vec<AccountId>>,
    ) -> Policy {
        let swarm_id = agent_id.to_string();
        let deposit = env::attached_deposit();
        // recreate payable semantics by forwarding deposit into register_swarm via direct insert
        valid_swarm_id(&swarm_id);
        require!(!self.swarms.contains_key(&swarm_id), "agent already registered");
        require!(!self.agents.contains_key(&agent_id), "agent already registered");
        require!(per_tx_cap.0 > 0 && daily_cap.0 > 0, "caps must be > 0");
        require!(per_tx_cap.0 <= daily_cap.0, "per_tx_cap must be <= daily_cap");
        let allowlist = allowlist.unwrap_or_default();
        require!(allowlist.len() <= MAX_LIST_LEN, "allowlist too long");
        let owner = env::predecessor_account_id();
        let s = Swarm {
            owner: owner.clone(),
            balance: U128(deposit.as_yoctonear()),
            per_tx_cap,
            daily_cap,
            spent_today: U128(0),
            day_index: today(),
            allowlist,
            blocklist: vec![],
            paused: false,
            total_sent: U128(0),
            tx_count: 0,
            blocked_count: 0,
            incidents: vec![],
            members: vec![agent_id.clone()],
        };
        self.swarms.insert(swarm_id.clone(), s);
        let m = AgentMember {
            swarm_id: swarm_id.clone(),
            per_tx_cap,
            daily_cap,
            spent_today: U128(0),
            day_index: today(),
            paused: false,
        };
        self.agents.insert(agent_id.clone(), m);
        emit("register_agent", near_sdk::serde_json::json!({"agent_id": agent_id, "owner": owner, "swarm_id": swarm_id}));
        self.get_agent(agent_id).unwrap()
    }

    #[payable]
    pub fn deposit(&mut self, agent_id: AccountId) -> U128 {
        let m = self.agents.get(&agent_id).unwrap_or_else(|| env::panic_str("unknown agent"));
        let swarm_id = m.swarm_id.clone();
        let s = self.swarms.get_mut(&swarm_id).unwrap_or_else(|| env::panic_str("unknown swarm"));
        s.balance = U128(s.balance.0 + env::attached_deposit().as_yoctonear());
        s.balance
    }

    #[payable]
    pub fn deposit_swarm(&mut self, swarm_id: String) -> U128 {
        let s = self.swarms.get_mut(&swarm_id).unwrap_or_else(|| env::panic_str("unknown swarm"));
        s.balance = U128(s.balance.0 + env::attached_deposit().as_yoctonear());
        s.balance
    }

    pub fn set_caps(&mut self, agent_id: AccountId, per_tx_cap: U128, daily_cap: U128) {
        require!(per_tx_cap.0 > 0 && daily_cap.0 > 0 && per_tx_cap.0 <= daily_cap.0, "invalid caps");
        let (swarm_id, _) = self.owner_agent(&agent_id);
        let swarm = self.swarms.get(&swarm_id).unwrap();
        require!(per_tx_cap.0 <= swarm.per_tx_cap.0, "agent per_tx_cap exceeds swarm");
        require!(daily_cap.0 <= swarm.daily_cap.0, "agent daily_cap exceeds swarm");
        let m = self.agents.get_mut(&agent_id).unwrap();
        m.per_tx_cap = per_tx_cap;
        m.daily_cap = daily_cap;
    }

    pub fn set_swarm_caps(&mut self, swarm_id: String, per_tx_cap: U128, daily_cap: U128) {
        require!(per_tx_cap.0 > 0 && daily_cap.0 > 0 && per_tx_cap.0 <= daily_cap.0, "invalid caps");
        let s = self.owner_swarm(&swarm_id);
        s.per_tx_cap = per_tx_cap;
        s.daily_cap = daily_cap;
    }

    pub fn set_paused(&mut self, agent_id: AccountId, paused: bool) {
        self.owner_agent(&agent_id);
        self.agents.get_mut(&agent_id).unwrap().paused = paused;
    }
    pub fn set_swarm_paused(&mut self, swarm_id: String, paused: bool) {
        self.owner_swarm(&swarm_id).paused = paused;
    }

    pub fn add_allow(&mut self, agent_id: AccountId, account_id: AccountId) {
        let (swarm_id, _) = self.owner_agent(&agent_id);
        let s = self.swarms.get_mut(&swarm_id).unwrap();
        require!(s.allowlist.len() < MAX_LIST_LEN, "allowlist full");
        if !s.allowlist.contains(&account_id) {
            s.allowlist.push(account_id);
        }
    }
    pub fn remove_allow(&mut self, agent_id: AccountId, account_id: AccountId) {
        let (swarm_id, _) = self.owner_agent(&agent_id);
        self.swarms.get_mut(&swarm_id).unwrap().allowlist.retain(|a| a != &account_id);
    }
    pub fn add_block(&mut self, agent_id: AccountId, account_id: AccountId) {
        let (swarm_id, _) = self.owner_agent(&agent_id);
        let s = self.swarms.get_mut(&swarm_id).unwrap();
        require!(s.blocklist.len() < MAX_LIST_LEN, "blocklist full");
        if !s.blocklist.contains(&account_id) {
            s.blocklist.push(account_id);
        }
    }
    pub fn remove_block(&mut self, agent_id: AccountId, account_id: AccountId) {
        let (swarm_id, _) = self.owner_agent(&agent_id);
        self.swarms.get_mut(&swarm_id).unwrap().blocklist.retain(|a| a != &account_id);
    }

    pub fn withdraw(&mut self, agent_id: AccountId, amount: U128) -> Promise {
        let (swarm_id, owner) = self.owner_agent(&agent_id);
        {
            let s = self.swarms.get_mut(&swarm_id).unwrap();
            require!(amount.0 > 0 && amount.0 <= s.balance.0, "insufficient vault balance");
            s.balance = U128(s.balance.0 - amount.0);
        }
        Promise::new(owner).transfer(NearToken::from_yoctonear(amount.0))
    }

    // ---------------- guarded spend path ----------------
    pub fn execute_transfer(
        &mut self,
        receiver_id: AccountId,
        amount: U128,
        memo: Option<String>,
    ) -> TransferOutcome {
        let agent = env::predecessor_account_id();
        let memo: String = memo.unwrap_or_default().chars().take(MAX_REASON_LEN).collect();
        self.do_transfer(agent, receiver_id, amount, memo, false)
    }

    /// Park a transfer for owner approval (medium-risk path). Does not debit.
    pub fn request_transfer(
        &mut self,
        receiver_id: AccountId,
        amount: U128,
        memo: Option<String>,
        reason: Option<String>,
    ) -> TransferOutcome {
        let agent = env::predecessor_account_id();
        let memo: String = memo.unwrap_or_default().chars().take(MAX_REASON_LEN).collect();
        let reason: String = reason
            .unwrap_or_else(|| "awaiting owner approval".into())
            .chars()
            .take(MAX_REASON_LEN)
            .collect();
        // Hard blocks still reject; otherwise create pending.
        let check = self.evaluate(&agent, &receiver_id, amount);
        if let Some(r) = check {
            // Only hard policy failures block here; caller can still record via execute.
            return self.record_block(&agent, receiver_id, amount, r, memo);
        }
        let m = self.agents.get(&agent).unwrap();
        let id = self.next_pending_id;
        self.next_pending_id += 1;
        let p = PendingTransfer {
            id,
            agent_id: agent.clone(),
            swarm_id: m.swarm_id.clone(),
            receiver_id: receiver_id.clone(),
            amount,
            memo,
            reason: reason.clone(),
            timestamp_ms: now_ms(),
        };
        self.pendings.insert(id, p);
        emit(
            "transfer_pending",
            near_sdk::serde_json::json!({"pending_id": id, "agent_id": agent, "receiver_id": receiver_id, "amount": amount, "reason": reason}),
        );
        outcome(false, "PENDING", reason, Some(id))
    }

    /// Owner approves a pending transfer; runs the real debit + send.
    pub fn approve_pending(&mut self, pending_id: u64) -> TransferOutcome {
        let pending = self.pendings.get(&pending_id).cloned().unwrap_or_else(|| env::panic_str("unknown pending"));
        let swarm = self.swarms.get(&pending.swarm_id).unwrap_or_else(|| env::panic_str("unknown swarm"));
        require!(swarm.owner == env::predecessor_account_id(), "owner only");
        self.pendings.remove(&pending_id);
        self.do_transfer(pending.agent_id, pending.receiver_id, pending.amount, pending.memo, true)
    }

    pub fn reject_pending(&mut self, pending_id: u64, reason: Option<String>) -> TransferOutcome {
        let pending = self.pendings.get(&pending_id).cloned().unwrap_or_else(|| env::panic_str("unknown pending"));
        let swarm = self.swarms.get(&pending.swarm_id).unwrap_or_else(|| env::panic_str("unknown swarm"));
        require!(swarm.owner == env::predecessor_account_id(), "owner only");
        self.pendings.remove(&pending_id);
        let reason = reason.unwrap_or_else(|| "rejected by owner".into());
        let reason: String = reason.chars().take(MAX_REASON_LEN).collect();
        emit(
            "transfer_rejected",
            near_sdk::serde_json::json!({"pending_id": pending_id, "agent_id": pending.agent_id, "reason": reason}),
        );
        // record as incident on the swarm
        if let Some(s) = self.swarms.get_mut(&pending.swarm_id) {
            s.blocked_count += 1;
            if s.incidents.len() >= MAX_INCIDENTS_PER_SWARM {
                s.incidents.remove(0);
            }
            s.incidents.push(Incident {
                receiver: pending.receiver_id,
                amount: pending.amount,
                reason: reason.clone(),
                memo: pending.memo,
                timestamp_ms: now_ms(),
                agent_id: Some(pending.agent_id),
            });
        }
        outcome(false, "REJECTED", reason, Some(pending_id))
    }

    fn do_transfer(
        &mut self,
        agent: AccountId,
        receiver_id: AccountId,
        amount: U128,
        memo: String,
        _from_pending: bool,
    ) -> TransferOutcome {
        if let Some(reason) = self.evaluate(&agent, &receiver_id, amount) {
            return self.record_block(&agent, receiver_id, amount, reason, memo);
        }
        let m = self.agents.get_mut(&agent).unwrap();
        let d = today();
        if m.day_index != d {
            m.day_index = d;
            m.spent_today = U128(0);
        }
        m.spent_today = U128(m.spent_today.0 + amount.0);
        let swarm_id = m.swarm_id.clone();
        let s = self.swarms.get_mut(&swarm_id).unwrap();
        if s.day_index != d {
            s.day_index = d;
            s.spent_today = U128(0);
        }
        s.balance = U128(s.balance.0 - amount.0);
        s.spent_today = U128(s.spent_today.0 + amount.0);
        s.total_sent = U128(s.total_sent.0 + amount.0);
        s.tx_count += 1;
        emit(
            "transfer",
            near_sdk::serde_json::json!({"agent_id": agent, "swarm_id": swarm_id, "receiver_id": receiver_id, "amount": amount, "memo": memo}),
        );
        let _ = Promise::new(receiver_id.clone())
            .transfer(NearToken::from_yoctonear(amount.0))
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(CALLBACK_GAS)
                    .on_transfer_done(agent, swarm_id, amount),
            );
        outcome(true, "SENT", "", None)
    }

    fn evaluate(&self, agent: &AccountId, receiver_id: &AccountId, amount: U128) -> Option<String> {
        let Some(m) = self.agents.get(agent) else {
            return Some("caller is not a registered agent".into());
        };
        let Some(s) = self.swarms.get(&m.swarm_id) else {
            return Some("unknown swarm".into());
        };
        let d = today();
        let agent_spent = if m.day_index == d { m.spent_today.0 } else { 0 };
        let swarm_spent = if s.day_index == d { s.spent_today.0 } else { 0 };
        let global = self.global_block.get(receiver_id).cloned();

        if amount.0 == 0 {
            Some("amount must be > 0".into())
        } else if s.paused {
            Some("swarm is paused by owner".into())
        } else if m.paused {
            Some("agent is paused by owner".into())
        } else if receiver_id == agent {
            Some("cannot pay self".into())
        } else if let Some(g) = global {
            Some(format!("receiver globally blocked: {}", g.reason))
        } else if s.blocklist.contains(receiver_id) {
            Some("receiver on owner blocklist".into())
        } else if !s.allowlist.is_empty() && !s.allowlist.contains(receiver_id) {
            Some("receiver not on allowlist".into())
        } else if amount.0 > m.per_tx_cap.0 {
            Some(format!("exceeds agent per-tx cap ({} > {})", amount.0, m.per_tx_cap.0))
        } else if agent_spent + amount.0 > m.daily_cap.0 {
            Some(format!("exceeds agent daily cap ({} + {} > {})", agent_spent, amount.0, m.daily_cap.0))
        } else if amount.0 > s.per_tx_cap.0 {
            Some(format!("exceeds swarm per-tx cap ({} > {})", amount.0, s.per_tx_cap.0))
        } else if swarm_spent + amount.0 > s.daily_cap.0 {
            Some(format!("exceeds swarm daily cap ({} + {} > {})", swarm_spent, amount.0, s.daily_cap.0))
        } else if amount.0 > s.balance.0 {
            Some("insufficient vault balance".into())
        } else {
            None
        }
    }

    fn record_block(
        &mut self,
        agent: &AccountId,
        receiver_id: AccountId,
        amount: U128,
        reason: String,
        memo: String,
    ) -> TransferOutcome {
        if let Some(m) = self.agents.get(agent) {
            let swarm_id = m.swarm_id.clone();
            if let Some(s) = self.swarms.get_mut(&swarm_id) {
                s.blocked_count += 1;
                if s.incidents.len() >= MAX_INCIDENTS_PER_SWARM {
                    s.incidents.remove(0);
                }
                s.incidents.push(Incident {
                    receiver: receiver_id.clone(),
                    amount,
                    reason: reason.clone(),
                    memo,
                    timestamp_ms: now_ms(),
                    agent_id: Some(agent.clone()),
                });
            }
        }
        emit(
            "transfer_blocked",
            near_sdk::serde_json::json!({"agent_id": agent, "receiver_id": receiver_id, "amount": amount, "reason": reason}),
        );
        outcome(false, "BLOCKED", reason, None)
    }

    #[private]
    pub fn on_transfer_done(
        &mut self,
        agent_id: AccountId,
        swarm_id: String,
        amount: U128,
        #[callback_result] result: Result<(), PromiseError>,
    ) -> bool {
        let ok = result.is_ok();
        if !ok {
            if let Some(s) = self.swarms.get_mut(&swarm_id) {
                s.balance = U128(s.balance.0 + amount.0);
                s.spent_today = U128(s.spent_today.0.saturating_sub(amount.0));
                s.total_sent = U128(s.total_sent.0.saturating_sub(amount.0));
                s.tx_count = s.tx_count.saturating_sub(1);
            }
            if let Some(m) = self.agents.get_mut(&agent_id) {
                m.spent_today = U128(m.spent_today.0.saturating_sub(amount.0));
            }
            emit("transfer_refunded", near_sdk::serde_json::json!({"agent_id": agent_id, "swarm_id": swarm_id, "amount": amount}));
        }
        ok
    }

    // ---------------- views ----------------
    pub fn get_agent(&self, agent_id: AccountId) -> Option<Policy> {
        let m = self.agents.get(&agent_id)?;
        let s = self.swarms.get(&m.swarm_id)?;
        Some(Policy {
            owner: s.owner.clone(),
            balance: s.balance,
            per_tx_cap: s.per_tx_cap,
            daily_cap: s.daily_cap,
            spent_today: s.spent_today,
            day_index: s.day_index,
            allowlist: s.allowlist.clone(),
            blocklist: s.blocklist.clone(),
            paused: s.paused || m.paused,
            total_sent: s.total_sent,
            tx_count: s.tx_count,
            blocked_count: s.blocked_count,
            incidents: s.incidents.clone(),
            swarm_id: m.swarm_id.clone(),
            agent_per_tx_cap: m.per_tx_cap,
            agent_daily_cap: m.daily_cap,
            agent_spent_today: if m.day_index == today() { m.spent_today } else { U128(0) },
            members: s.members.clone(),
        })
    }

    pub fn get_swarm(&self, swarm_id: String) -> Option<Swarm> {
        self.swarms.get(&swarm_id).cloned()
    }

    pub fn get_pending(&self, pending_id: u64) -> Option<PendingTransfer> {
        self.pendings.get(&pending_id).cloned()
    }

    pub fn list_pendings(&self, swarm_id: Option<String>, from_index: Option<u32>, limit: Option<u32>) -> Vec<PendingTransfer> {
        let skip = from_index.unwrap_or(0) as usize;
        let take = limit.unwrap_or(50).min(100) as usize;
        self.pendings
            .iter()
            .filter(|(_, p)| swarm_id.as_ref().map(|s| &p.swarm_id == s).unwrap_or(true))
            .map(|(_, p)| p.clone())
            .skip(skip)
            .take(take)
            .collect()
    }

    pub fn check_transfer(&self, agent_id: AccountId, receiver_id: AccountId, amount: U128) -> TransferOutcome {
        match self.evaluate(&agent_id, &receiver_id, amount) {
            Some(r) => outcome(false, "BLOCKED", r, None),
            None => outcome(true, "ALLOW", "", None),
        }
    }

    pub fn receiver_status(&self, account_id: AccountId) -> ReceiverStatus {
        let reports = self.reports.get(&account_id);
        let n = reports.map(|r| r.len() as u32).unwrap_or(0);
        let g = self.global_block.get(&account_id);
        ReceiverStatus {
            globally_blocked: g.is_some(),
            block_reason: g.map(|g| g.reason.clone()),
            report_count: n,
            distinct_reporters: n,
        }
    }
    pub fn get_reports(&self, account_id: AccountId) -> Vec<Report> {
        self.reports.get(&account_id).cloned().unwrap_or_default()
    }
    pub fn list_global_blocks(&self, from_index: Option<u32>, limit: Option<u32>) -> Vec<(AccountId, GlobalBlock)> {
        self.global_block
            .iter()
            .skip(from_index.unwrap_or(0) as usize)
            .take(limit.unwrap_or(50).min(100) as usize)
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect()
    }
    pub fn list_agents(&self, from_index: Option<u32>, limit: Option<u32>) -> Vec<AccountId> {
        self.agents
            .keys()
            .skip(from_index.unwrap_or(0) as usize)
            .take(limit.unwrap_or(50).min(100) as usize)
            .cloned()
            .collect()
    }
    pub fn list_swarms(&self, from_index: Option<u32>, limit: Option<u32>) -> Vec<String> {
        self.swarms
            .keys()
            .skip(from_index.unwrap_or(0) as usize)
            .take(limit.unwrap_or(50).min(100) as usize)
            .cloned()
            .collect()
    }
    pub fn get_config(&self) -> Config {
        Config {
            admin: self.admin.clone(),
            report_threshold: self.report_threshold,
            guardians: self.guardians.keys().cloned().collect(),
        }
    }

    // ---------------- internal ----------------
    fn assert_admin(&self) {
        require!(env::predecessor_account_id() == self.admin, "admin only");
    }
    fn assert_guardian(&self) {
        require!(self.guardians.contains_key(&env::predecessor_account_id()), "guardian only");
    }
    fn owner_swarm(&mut self, swarm_id: &str) -> &mut Swarm {
        let caller = env::predecessor_account_id();
        let s = self.swarms.get_mut(swarm_id).unwrap_or_else(|| env::panic_str("unknown swarm"));
        require!(s.owner == caller, "owner only");
        s
    }
    fn owner_agent(&self, agent_id: &AccountId) -> (String, AccountId) {
        let caller = env::predecessor_account_id();
        let m = self.agents.get(agent_id).unwrap_or_else(|| env::panic_str("unknown agent"));
        let s = self.swarms.get(&m.swarm_id).unwrap_or_else(|| env::panic_str("unknown swarm"));
        require!(s.owner == caller, "owner only");
        (m.swarm_id.clone(), s.owner.clone())
    }
}

#[cfg(test)]
mod tests;
