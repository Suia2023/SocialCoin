module club::club {
    use std::vector;
    use sui::clock::{Clock, timestamp_ms};
    use sui::table_vec;
    use socialcoin::socialcoin::is_holder;
    use socialcoin::socialcoin;
    use sui::transfer::share_object;
    use sui::table;
    use sui::tx_context;
    use sui::tx_context::TxContext;
    use sui::table::Table;
    use sui::table_vec::TableVec;
    use sui::object::{UID, new};

    // errors
    const ERR_NOT_AUTHORIZED: u64 = 1;
    const ERR_MESSAGE_NOT_FOUND: u64 = 2;
    const ERR_MESSAGE_DELETED: u64 = 3;

    struct Global has key, store {
        id: UID,
        admin: address,
        clubs: Table<address, Club>,
    }

    struct Club has store {
        owner: address,
        messages: TableVec<Message>
    }

    struct Message has store {
        sender: address,
        content: vector<u8>,
        timestamp: u64,
        deleted: bool,
    }

    fun init(ctx: &mut TxContext) {
        let sender = tx_context::sender(ctx);
        let global = Global {
            id: new(ctx),
            admin: sender,
            clubs: table::new(ctx),
        };
        share_object(global);
    }


    entry public fun new_message(
        clock: &Clock,
        social_coin_global: &socialcoin::Global,
        club_global: &mut Global,
        club_owner: address,
        content: vector<u8>,
        ctx: &mut TxContext,
    ) {
        let sender = tx_context::sender(ctx);
        assert!(is_holder(social_coin_global, sender, club_owner), ERR_NOT_AUTHORIZED);
        if(!table::contains(&club_global.clubs, club_owner)) {
            let club = Club {
                owner: club_owner,
                messages: table_vec::empty(ctx),
            };
            table::add(&mut club_global.clubs, club_owner, club);
        };
        let club = table::borrow_mut(&mut club_global.clubs, club_owner);
        let message = Message {
            sender,
            content,
            timestamp: timestamp_ms(clock),
            deleted: false,
        };
        table_vec::push_back(&mut club.messages, message);
    }

    entry public fun delete_message(
        club_global: &mut Global,
        club_owner: address,
        message_index: u64,
        ctx: &mut TxContext,
    ) {
        let sender = tx_context::sender(ctx);
        let club = table::borrow_mut(&mut club_global.clubs, club_owner);
        assert!(message_index < table_vec::length(&club.messages), ERR_MESSAGE_NOT_FOUND);
        let message = table_vec::borrow_mut(&mut club.messages, message_index);
        assert!(message.sender == sender, ERR_NOT_AUTHORIZED);
        assert!(!message.deleted, ERR_MESSAGE_DELETED);
        message.content = vector::empty();
        message.deleted = true;
    }
}
