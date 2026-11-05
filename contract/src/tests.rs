use super::*;
use near_sdk::test_utils::{accounts, VMContextBuilder};
use near_sdk::testing_env;

const ONE: u128 = 1_000_000_000_000_000_000_000_000;

fn ctx(pred: usize, deposit: u128, ts_days: u64) {
    let mut b = VMContextBuilder::new();
    b.current_account_id("guard.testnet".parse().unwrap())
        .predecessor_account_id(accounts(pred))
        .attached_deposit(NearToken::from_yoctonear(deposit))
        .block_timestamp(ts_days * NANOS_PER_DAY + 1000);
    testing_env!(b.build());
}
// accounts: 0 alice(admin) 1 bob(owner) 2 charlie(agent) 3 danny(merchant) 4 eugene(scam) 5 fargo
fn setup() -> AgentGuard {
    ctx(0, 0, 10);
    let mut c = AgentGuard::new(accounts(0), Some(2));
    ctx(1, 5 * ONE, 10);
    c.register_agent(accounts(2), U128(ONE), U128(2 * ONE), None);
    c
}

#[test]
fn register_and_view() {
    let c = setup();
    let p = c.get_agent(accounts(2)).unwrap();
    assert_eq!(p.owner, accounts(1));
    assert_eq!(p.balance.0, 5 * ONE);
    assert_eq!(p.swarm_id, accounts(2).to_string());
    assert_eq!(p.members, vec![accounts(2)]);
}

#[test]
#[should_panic(expected = "per_tx_cap must be <= daily_cap")]
fn bad_caps() {
    ctx(0, 0, 10);
    let mut c = AgentGuard::new(accounts(0), None);
    c.register_agent(accounts(2), U128(3), U128(2), None);
}

#[test]
fn allowed_transfer_debits() {
    let mut c = setup();
    ctx(2, 0, 10);
    let o = c.execute_transfer(accounts(3), U128(ONE / 2), Some("api fee".into()));
    assert!(o.ok, "{:?}", o);
    let p = c.get_agent(accounts(2)).unwrap();
    assert_eq!(p.balance.0, 5 * ONE - ONE / 2);
    assert_eq!(p.spent_today.0, ONE / 2);
    assert_eq!(p.agent_spent_today.0, ONE / 2);
}

#[test]
fn per_tx_cap_blocks_and_records_incident() {
    let mut c = setup();
    ctx(2, 0, 10);
    let o = c.execute_transfer(accounts(3), U128(ONE + 1), None);
    assert!(!o.ok);
    assert!(o.reason.contains("per-tx cap"));
    let p = c.get_agent(accounts(2)).unwrap();
    assert_eq!(p.blocked_count, 1);
    assert_eq!(p.incidents.len(), 1);
    assert_eq!(p.balance.0, 5 * ONE);
}

#[test]
fn daily_cap_and_reset_next_day() {
    let mut c = setup();
    ctx(2, 0, 10);
    assert!(c.execute_transfer(accounts(3), U128(ONE), None).ok);
    assert!(c.execute_transfer(accounts(3), U128(ONE), None).ok);
    let o = c.execute_transfer(accounts(3), U128(1), None);
    assert!(!o.ok && o.reason.contains("daily cap"), "{:?}", o);
    ctx(2, 0, 11);
    assert!(c.execute_transfer(accounts(3), U128(ONE), None).ok);
}

#[test]
fn owner_blocklist_and_allowlist() {
    let mut c = setup();
    ctx(1, 0, 10);
    c.add_block(accounts(2), accounts(4));
    ctx(2, 0, 10);
    assert!(c.execute_transfer(accounts(4), U128(1), None).reason.contains("owner blocklist"));
    ctx(1, 0, 10);
    c.add_allow(accounts(2), accounts(3));
    ctx(2, 0, 10);
    assert!(c.execute_transfer(accounts(5), U128(1), None).reason.contains("allowlist"));
    assert!(c.execute_transfer(accounts(3), U128(1), None).ok);
}

#[test]
fn community_reports_reach_threshold() {
    let mut c = setup();
    ctx(3, 0, 10);
    let s = c.report(accounts(4), "drainer contract, tx abc".into());
    assert!(!s.globally_blocked);
    ctx(5, 0, 10);
    let s = c.report(accounts(4), "phishing site".into());
    assert!(s.globally_blocked);
    ctx(2, 0, 10);
    let o = c.execute_transfer(accounts(4), U128(1), None);
    assert!(o.reason.contains("globally blocked"), "{:?}", o);
    assert!(!c.check_transfer(accounts(2), accounts(4), U128(1)).ok);
}

#[test]
fn guardian_report_blocks_immediately() {
    let mut c = setup();
    ctx(0, 0, 10);
    assert!(c.report(accounts(4), "known drainer".into()).globally_blocked);
    c.unblock(accounts(4));
    assert!(!c.receiver_status(accounts(4)).globally_blocked);
}

#[test]
#[should_panic(expected = "already reported by you")]
fn duplicate_report() {
    let mut c = setup();
    ctx(3, 0, 10);
    c.report(accounts(4), "x".into());
    c.report(accounts(4), "x".into());
}

#[test]
#[should_panic(expected = "evidence required")]
fn empty_evidence() {
    let mut c = setup();
    ctx(3, 0, 10);
    c.report(accounts(4), "  ".into());
}

#[test]
#[should_panic(expected = "owner only")]
fn non_owner_cannot_change_policy() {
    let mut c = setup();
    ctx(2, 0, 10);
    c.set_caps(accounts(2), U128(100 * ONE), U128(100 * ONE));
}

#[test]
#[should_panic(expected = "guardian only")]
fn non_guardian_confirm() {
    let mut c = setup();
    ctx(3, 0, 10);
    c.confirm_block(accounts(4), "x".into());
}

#[test]
fn paused_and_self_pay_blocked() {
    let mut c = setup();
    ctx(2, 0, 10);
    assert!(c.execute_transfer(accounts(2), U128(1), None).reason.contains("self"));
    ctx(1, 0, 10);
    c.set_paused(accounts(2), true);
    ctx(2, 0, 10);
    assert!(c.execute_transfer(accounts(3), U128(1), None).reason.contains("paused"));
}

#[test]
fn refund_on_failed_transfer() {
    let mut c = setup();
    ctx(2, 0, 10);
    assert!(c.execute_transfer(accounts(3), U128(ONE), None).ok);
    let mut b = VMContextBuilder::new();
    b.current_account_id("guard.testnet".parse().unwrap())
        .predecessor_account_id("guard.testnet".parse().unwrap())
        .block_timestamp(10 * NANOS_PER_DAY + 2000);
    testing_env!(b.build());
    assert!(!c.on_transfer_done(accounts(2), accounts(2).to_string(), U128(ONE), Err(near_sdk::PromiseError::Failed)));
    let p = c.get_agent(accounts(2)).unwrap();
    assert_eq!(p.balance.0, 5 * ONE);
    assert_eq!(p.spent_today.0, 0);
    assert_eq!(p.agent_spent_today.0, 0);
}

#[test]
fn insufficient_balance() {
    ctx(0, 0, 10);
    let mut c = AgentGuard::new(accounts(0), None);
    ctx(1, 10, 10);
    c.register_agent(accounts(2), U128(ONE), U128(ONE), None);
    ctx(2, 0, 10);
    assert!(c.execute_transfer(accounts(3), U128(11), None).reason.contains("insufficient"));
}

#[test]
fn swarm_shared_vault_and_per_agent_caps() {
    ctx(0, 0, 10);
    let mut c = AgentGuard::new(accounts(0), Some(2));
    // owner registers swarm with shared caps: per_tx 1N, daily 2N, vault 5N
    ctx(1, 5 * ONE, 10);
    c.register_swarm("crew".into(), U128(ONE), U128(2 * ONE), None);
    // agent A (accounts 2): per_tx 0.5N, daily 1N
    ctx(1, 0, 10);
    c.add_agent("crew".into(), accounts(2), U128(ONE / 2), U128(ONE));
    // agent B (accounts 5): per_tx 0.5N, daily = swarm daily so shared cap is the limiter
    c.add_agent("crew".into(), accounts(5), U128(ONE / 2), U128(2 * ONE));

    let swarm = c.get_swarm("crew".into()).unwrap();
    assert_eq!(swarm.members.len(), 2);
    assert_eq!(swarm.balance.0, 5 * ONE);

    // agent A hits its own per-tx cap
    ctx(2, 0, 10);
    let o = c.execute_transfer(accounts(3), U128(ONE / 2 + 1), None);
    assert!(!o.ok && o.reason.contains("agent per-tx"), "{:?}", o);

    // agent A spends its full daily 1N across two txs
    assert!(c.execute_transfer(accounts(3), U128(ONE / 2), None).ok);
    assert!(c.execute_transfer(accounts(3), U128(ONE / 2), None).ok);
    let o = c.execute_transfer(accounts(3), U128(1), None);
    assert!(!o.ok && o.reason.contains("agent daily"), "{:?}", o);

    // agent B can still spend (shared daily still has 1N left; agent B daily is 2N)
    ctx(5, 0, 10);
    assert!(c.execute_transfer(accounts(3), U128(ONE / 2), None).ok);
    assert!(c.execute_transfer(accounts(3), U128(ONE / 2), None).ok);

    // shared daily now exhausted (agent B still has daily room)
    let o = c.execute_transfer(accounts(3), U128(1), None);
    assert!(!o.ok && o.reason.contains("swarm daily"), "{:?}", o);

    let p_a = c.get_agent(accounts(2)).unwrap();
    let p_b = c.get_agent(accounts(5)).unwrap();
    assert_eq!(p_a.balance.0, 5 * ONE - 2 * ONE); // 2N spent total
    assert_eq!(p_a.balance.0, p_b.balance.0); // shared vault
    assert_eq!(p_a.members.len(), 2);
}

#[test]
fn swarm_owner_add_remove_agent() {
    ctx(0, 0, 10);
    let mut c = AgentGuard::new(accounts(0), None);
    ctx(1, 3 * ONE, 10);
    c.register_swarm("crew".into(), U128(ONE), U128(ONE), None);
    ctx(1, 0, 10);
    c.add_agent("crew".into(), accounts(2), U128(ONE / 2), U128(ONE));
    c.add_agent("crew".into(), accounts(5), U128(ONE / 2), U128(ONE));
    assert_eq!(c.get_swarm("crew".into()).unwrap().members.len(), 2);
    c.remove_agent(accounts(5));
    assert_eq!(c.get_swarm("crew".into()).unwrap().members.len(), 1);
    assert!(c.get_agent(accounts(5)).is_none());
    // removed agent cannot spend
    ctx(5, 0, 10);
    let o = c.execute_transfer(accounts(3), U128(1), None);
    assert!(!o.ok);
    assert!(o.reason.contains("not a registered agent"), "{:?}", o);
}

#[test]
fn pending_approve_and_reject() {
    let mut c = setup();
    ctx(2, 0, 10);
    let o = c.request_transfer(accounts(3), U128(ONE / 2), Some("risky".into()), Some("medium risk".into()));
    assert_eq!(o.status, "PENDING");
    let pid = o.pending_id.unwrap();
    assert_eq!(c.list_pendings(None, None, None).len(), 1);
    // vault untouched while pending
    assert_eq!(c.get_agent(accounts(2)).unwrap().balance.0, 5 * ONE);

    // non-owner cannot approve
    // owner approves
    ctx(1, 0, 10);
    let o = c.approve_pending(pid);
    assert!(o.ok, "{:?}", o);
    assert_eq!(o.status, "SENT");
    assert_eq!(c.get_agent(accounts(2)).unwrap().balance.0, 5 * ONE - ONE / 2);
    assert!(c.get_pending(pid).is_none());

    // another pending then reject
    ctx(2, 0, 10);
    let o = c.request_transfer(accounts(3), U128(ONE / 4), None, None);
    let pid2 = o.pending_id.unwrap();
    ctx(1, 0, 10);
    let o = c.reject_pending(pid2, Some("nope".into()));
    assert_eq!(o.status, "REJECTED");
    assert!(c.get_pending(pid2).is_none());
    let p = c.get_agent(accounts(2)).unwrap();
    assert!(p.incidents.iter().any(|i| i.reason.contains("nope")));
}

#[test]
fn pending_hard_block_still_blocks() {
    let mut c = setup();
    ctx(1, 0, 10);
    c.add_block(accounts(2), accounts(4));
    ctx(2, 0, 10);
    let o = c.request_transfer(accounts(4), U128(1), None, Some("try".into()));
    assert_eq!(o.status, "BLOCKED");
    assert!(o.pending_id.is_none());
    assert!(c.list_pendings(None, None, None).is_empty());
}

#[test]
#[should_panic(expected = "agent per_tx_cap exceeds swarm")]
fn agent_caps_cannot_exceed_swarm() {
    ctx(0, 0, 10);
    let mut c = AgentGuard::new(accounts(0), None);
    ctx(1, ONE, 10);
    c.register_swarm("crew".into(), U128(ONE / 2), U128(ONE), None);
    ctx(1, 0, 10);
    c.add_agent("crew".into(), accounts(2), U128(ONE), U128(ONE));
}
