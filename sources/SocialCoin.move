module socialcoin::socialcoin {
    use sui::balance::{Self, Balance};
    use sui::coin::{Self, Coin};
    use sui::event;
    use sui::object::{Self, UID};
    use sui::package;
    use sui::sui;
    use sui::table::{Self, Table};
    use sui::transfer::{Self, public_transfer};
    use sui::tx_context::{TxContext, sender};
    #[test_only]
    use sui::test_scenario::{Self, return_shared, return_to_address};
    #[test_only]
    use sui::coin::{mint_for_testing};

    // errors
    const ERR_ONLY_SHARES_SUBJECT_CAN_BUY_FIRST_SHARE: u64 = 1;
    const ERR_INSUFFICIENT_COIN: u64 = 2;
    const ERR_SUBJECT_NOT_FOUND: u64 = 3;
    const ERR_INSUFFICIENT_SHARES: u64 = 4;
    const ERR_INSUFFICIENT_SUPPLY: u64 = 5;

    struct SOCIALCOIN has drop {}

    struct AdminCap has key { id: UID }

    struct Global has key, store {
        id: UID,
        shares: Table<address, Shares>,
        config: Config,
        vault: Balance<sui::SUI>,
    }

    struct Shares has store {
        // holder  => balance
        holders: Table<address, u64>,
        // total supply
        supply: u64,
        // subject => balance
        holding: Table<address, u64>,
    }

    struct Config has store {
        protocol_fee_destination: address,
        // unit: 10^-9, 5% = 50000000
        protocol_fee_percent: u64,
        // unit: 10^-9, 5% = 50000000
        subject_fee_percent: u64,
    }

    struct TradeEvent has copy, drop {
        trader: address,
        subject: address,
        is_buy: bool,
        share_amount: u64,
        sui_amount: u64,
        protocol_sui_amount: u64,
        subject_sui_amount: u64,
        supply: u64,
    }

    fun init(otw: SOCIALCOIN, ctx: &mut TxContext) {
        let publisher = package::claim(otw, ctx);
        transfer::public_transfer(publisher, sender(ctx));

        init_social_coin(ctx);
    }

    fun init_social_coin(ctx: &mut TxContext) {
        let admin_cap = AdminCap { id: object::new(ctx) };
        transfer::transfer(admin_cap, sender(ctx));

        let global = Global {
            id: object::new(ctx),
            config: Config {
                protocol_fee_destination: sender(ctx),
                protocol_fee_percent: 10000000,
                subject_fee_percent: 10000000,
            },
            shares: table::new(ctx),
            vault: balance::zero(),
        };
        transfer::share_object(global);
    }

    public fun update_config(
        global: &mut Global,
        _: &AdminCap,
        protocol_fee_destination: address,
        protocol_fee_percent: u64,
        subject_fee_percent: u64,
        _ctx: &mut TxContext,
    ) {
        global.config.protocol_fee_destination = protocol_fee_destination;
        global.config.protocol_fee_percent = protocol_fee_percent;
        global.config.subject_fee_percent = subject_fee_percent;
    }

    public fun get_price(supply: u64, amount: u64): u64 {
        let sum1 = if (supply == 0) { 0 } else { (supply - 1) * (supply) * (2 * (supply - 1) + 1) / 6 };
        let sum2 = if (supply == 0 && amount == 1) { 0 } else { (supply - 1 + amount) * (supply + amount) * (2 * (supply - 1 + amount) + 1) / 6 };
        let summation = sum2 - sum1;
        summation * 100000000
    }

    public fun get_buy_price(global: &Global, subject: address, amount: u64): u64 {
        let total_supply = 0;
        if (table::contains(&global.shares, subject)) {
            let shares = table::borrow(&global.shares, subject);
            total_supply = shares.supply;
        };
        get_price(total_supply, amount)
    }

    public fun get_sell_price(global: &Global, subject: address, amount: u64): u64 {
        let shares = table::borrow(&global.shares, subject);
        let total_supply = shares.supply;
        get_price(total_supply - amount, amount)
    }

    public fun get_buy_price_after_fee(global: &Global, subject: address, amount: u64): u64 {
        let price = get_buy_price(global, subject, amount);
        let protocol_fee = price * global.config.protocol_fee_percent / 1000000000;
        let subject_fee = price * global.config.subject_fee_percent / 1000000000;
        price + protocol_fee + subject_fee
    }

    public fun get_sell_price_after_fee(global: &Global, subject: address, amount: u64): u64 {
        let price = get_sell_price(global, subject, amount);
        let protocol_fee = price * global.config.protocol_fee_percent / 1000000000;
        let subject_fee = price * global.config.subject_fee_percent / 1000000000;
        price - protocol_fee - subject_fee
    }

    fun ensure_share_created(
        global: &mut Global,
        subject: address,
        ctx: &mut TxContext,
    ) {
        if (!table::contains(&global.shares, subject)) {
            let shares = Shares {
                holders: table::new(ctx),
                supply: 0,
                holding: table::new(ctx),
            };
            table::add(&mut global.shares, subject, shares);
        };
    }

    fun change_table_value(
        table: &mut Table<address, u64>,
        key: address,
        value: u64,
        is_add: bool,
    ) {
        if (!table::contains(table, key)) {
            table::add(table, key, 0);
        };
        let table_value = table::borrow_mut(table, key);
        if (is_add) {
            *table_value = *table_value + value;
        } else {
            *table_value = *table_value - value;
            if (*table_value == 0) {
                table::remove(table, key);
            };
        };
    }

    public fun buy_shares(
        global: &mut Global,
        subject: address,
        amount: u64,
        coin: Coin<sui::SUI>,
        ctx: &mut TxContext,
    ) {
        let trader = sender(ctx);
        ensure_share_created(global, subject, ctx);
        let subject_share = table::borrow_mut(&mut global.shares, subject);
        let supply = subject_share.supply;
        assert!(supply > 0 || trader == subject, ERR_ONLY_SHARES_SUBJECT_CAN_BUY_FIRST_SHARE);
        let price = get_price(supply, amount);
        let protocol_fee = price * global.config.protocol_fee_percent / 1000000000;
        let subject_fee = price * global.config.subject_fee_percent / 1000000000;
        assert!(coin::value(&coin) >= price + protocol_fee + subject_fee, ERR_INSUFFICIENT_COIN);
        change_table_value(&mut subject_share.holders, trader, amount, true);
        subject_share.supply = supply + amount;
        change_holding_data(global, trader, subject, amount, true, ctx);
        event::emit(TradeEvent {
            trader,
            subject,
            is_buy: true,
            share_amount: amount,
            sui_amount: price,
            protocol_sui_amount: protocol_fee,
            subject_sui_amount: subject_fee,
            supply: supply + amount,
        });

        if (price > 0) {
            balance::join(&mut global.vault, coin::into_balance(coin::split(&mut coin, price, ctx)));
        };
        if (protocol_fee > 0) {
            public_transfer(coin::split(&mut coin, protocol_fee, ctx), global.config.protocol_fee_destination);
        };
        if (subject_fee > 0) {
            public_transfer(coin::split(&mut coin, subject_fee, ctx), subject);
        };
        public_transfer(coin, trader);
    }

    fun transfer_from_vault(
        global: &mut Global,
        amount: u64,
        receiver: address,
        ctx: &mut TxContext,
    ) {
        if (amount == 0) {
            return
        };
        public_transfer(coin::from_balance(balance::split(&mut global.vault, amount), ctx), receiver);
    }

    fun change_holding_data(
        global: &mut Global,
        trader: address,
        subject: address,
        amount: u64,
        is_add: bool,
        ctx: &mut TxContext,
    ) {
        if (is_add) {
            ensure_share_created(global, trader, ctx);
        };
        let trader_share = table::borrow_mut(&mut global.shares, trader);
        change_table_value(&mut trader_share.holding, subject, amount, is_add);
    }

    public fun sell_shares(
        global: &mut Global,
        subject: address,
        amount: u64,
        ctx: &mut TxContext,
    ) {
        assert!(table::contains(&global.shares, subject), ERR_SUBJECT_NOT_FOUND);
        let trader = sender(ctx);
        let subject_share = table::borrow_mut(&mut global.shares, subject);
        let supply = subject_share.supply;
        assert!(supply >= amount, ERR_INSUFFICIENT_SUPPLY);
        let price = get_price(supply - amount, amount);
        let protocol_fee = price * global.config.protocol_fee_percent / 1000000000;
        let subject_fee = price * global.config.subject_fee_percent / 1000000000;
        let trader_balance = table::borrow_mut(&mut subject_share.holders, trader);
        assert!(*trader_balance >= amount, ERR_INSUFFICIENT_SHARES);
        *trader_balance = *trader_balance - amount;
        subject_share.supply = supply - amount;
        if (*trader_balance == 0) {
            table::remove(&mut subject_share.holders, trader);
        };
        change_holding_data(global, trader, subject, amount, false, ctx);
        event::emit(TradeEvent {
            trader,
            subject,
            is_buy: false,
            share_amount: amount,
            sui_amount: price,
            protocol_sui_amount: protocol_fee,
            subject_sui_amount: subject_fee,
            supply: supply - amount,
        });
        let protocol_fee_destination = global.config.protocol_fee_destination;
        transfer_from_vault(global, price - protocol_fee - subject_fee, trader, ctx);
        transfer_from_vault(global, subject_fee, subject, ctx);
        transfer_from_vault(global, protocol_fee, protocol_fee_destination, ctx);
    }

    #[test]
    fun test_social_coin() {
        let admin = @0xBABE;
        let user1 = @0xFACE;
        let user2 = @0xCAFE;

        let scenario_val = test_scenario::begin(admin);
        let scenario = &mut scenario_val;

        // init
        test_scenario::next_tx(scenario, admin);
        init_social_coin(test_scenario::ctx(scenario));

        // user1 buy first user1 free share
        test_scenario::next_tx(scenario, user1);
        let global = test_scenario::take_shared<Global>(scenario);
        let coin = mint_for_testing<sui::SUI>(1000000000, test_scenario::ctx(scenario));
        buy_shares(&mut global, user1, 1, coin, test_scenario::ctx(scenario));
        // the first share is free, so the price is 0
        let vault_balance_after_user1_buy_user1 = balance::value(&global.vault);
        assert!(vault_balance_after_user1_buy_user1 == 0, 0);
        let user1_share = table::borrow(&global.shares, user1);
        assert!(table::length(&user1_share.holding) == 1, 0);
        assert!(table::length(&user1_share.holders) == 1, 0);
        assert!(*table::borrow(&user1_share.holding, user1) == 1, 0);
        assert!(*table::borrow(&user1_share.holders, user1) == 1, 0);

        // user2 buy user1's share
        test_scenario::next_tx(scenario, user2);
        let coin2 = mint_for_testing<sui::SUI>(100000000000, test_scenario::ctx(scenario));
        let amount = 10;
        buy_shares(&mut global, user1, amount, coin2, test_scenario::ctx(scenario));

        test_scenario::next_tx(scenario, user2);
        let price1 = get_price(1, amount);
        let protocol_fee1 = price1 * global.config.protocol_fee_percent / 1000000000;
        let subject_fee1 = price1 * global.config.subject_fee_percent / 1000000000;
        let vault_balance_after_user2_buy_user1 = balance::value(&global.vault);
        assert!(vault_balance_after_user2_buy_user1 == price1, 0);
        let expected_subject_fee1 = test_scenario::take_from_address<Coin<sui::SUI>>(scenario, user1);
        assert!(coin::value(&expected_subject_fee1) == subject_fee1, 0);
        let expected_protocol_fee1 = test_scenario::take_from_address<Coin<sui::SUI>>(scenario, admin);
        assert!(coin::value(&expected_protocol_fee1) == protocol_fee1, 0);
        return_to_address(user1, expected_subject_fee1);
        return_to_address(admin, expected_protocol_fee1);
        let user1_share = table::borrow(&global.shares, user1);
        assert!(table::length(&user1_share.holding) == 1, 0);
        assert!(table::length(&user1_share.holders) == 2, 0);
        assert!(*table::borrow(&user1_share.holders, user2) == amount, 0);
        let user2_share = table::borrow(&global.shares, user2);
        assert!(table::length(&user2_share.holding) == 1, 0);
        assert!(table::length(&user2_share.holders) == 0, 0);
        assert!(*table::borrow(&user2_share.holding, user1) == amount, 0);

        // user2 sell user1's share
        test_scenario::next_tx(scenario, user2);
        sell_shares(&mut global, user1, 1, test_scenario::ctx(scenario));
        test_scenario::next_tx(scenario, user2);

        let user1_share = table::borrow(&global.shares, user1);
        assert!(*table::borrow(&user1_share.holders, user2) == amount - 1, 0);
        let user2_share = table::borrow(&global.shares, user2);
        assert!(*table::borrow(&user2_share.holding, user1) == amount - 1, 0);

        test_scenario::next_tx(scenario, user2);
        sell_shares(&mut global, user1, amount - 1, test_scenario::ctx(scenario));
        test_scenario::next_tx(scenario, user2);
        assert!(balance::value(&global.vault) == 0, 0);

        // end test
        return_shared(global);
        test_scenario::end(scenario_val);
    }
}
