'use strict';

function optionalData(result) {
  return result && result.data ? result.data : null;
}

function listData(result) {
  return result && Array.isArray(result.data) ? result.data : [];
}

function createTransactionStore(source) {
  return {
    async getOrder(id) {
      return optionalData(await source.collection('shop_orders').doc(id).get());
    },
    async getSession(id) {
      return optionalData(await source.collection('sessions').doc(id).get());
    },
    async getStore(id) {
      return optionalData(await source.collection('stores').doc(id).get());
    },
    async getPaymentProfile(id) {
      return optionalData(
        await source.collection('shop_payment_profiles').doc(id).get()
      );
    },
    async getFinancialEvent(id) {
      return optionalData(await source.collection('financial_events').doc(id).get());
    },
    async getOccupancy(id) {
      return optionalData(await source.collection('table_occupancies').doc(id).get());
    },
    async getVerifiedTraining(id) {
      return optionalData(await source.collection('training_sessions').doc(id).get());
    },
    async getVerifiedCoachLesson(id) {
      return optionalData(await source.collection('coach_lessons').doc(id).get());
    },
    async getEntitlementCheckin(id) {
      return optionalData(await source.collection('checkin_requests').doc(id).get());
    },
    async getCoachLink(id) {
      return optionalData(await source.collection('shop_coach_links').doc(id).get());
    },
    async updateOrder(id, data) {
      await source.collection('shop_orders').doc(id).update({ data });
    },
    async updateSession(id, data) {
      await source.collection('sessions').doc(id).update({ data });
    },
    async setFinancialEvent(id, document) {
      await source.collection('financial_events').doc(id).set({
        data: { _id: id, ...document }
      });
    },
    async setVerifiedTraining(id, document) {
      await source.collection('training_sessions').doc(id).set({
        data: { _id: id, ...document }
      });
    },
    async setVerifiedCoachLesson(id, document) {
      await source.collection('coach_lessons').doc(id).set({
        data: { _id: id, ...document }
      });
    },
    async removeOccupancy(id) {
      await source.collection('table_occupancies').doc(id).remove();
    }
  };
}

function createCloudbasePaymentStore(db) {
  if (
    !db
    || typeof db.collection !== 'function'
    || typeof db.runTransaction !== 'function'
    || typeof db.serverDate !== 'function'
    || !db.command
    || typeof db.command.lte !== 'function'
    || typeof db.command.in !== 'function'
  ) {
    throw new TypeError('CloudBase database is required');
  }
  return Object.freeze({
    async findOrdersByTokenHash(checkoutTokenHash, limit) {
      return listData(await db.collection('shop_orders')
        .where({ checkoutTokenHash })
        .limit(limit)
        .get());
    },
    async findOrdersByOutTradeNo(outTradeNo, limit) {
      const pages = await Promise.all([
        db.collection('shop_orders')
          .where({ outTradeNo })
          .limit(limit)
          .get(),
        db.collection('shop_orders')
          .where({ previousOutTradeNos: db.command.in([outTradeNo]) })
          .limit(limit)
          .get()
      ]);
      const unique = new Map();
      for (const page of pages) {
        for (const order of listData(page)) {
          if (order && typeof order._id === 'string' && !unique.has(order._id)) {
            unique.set(order._id, order);
          }
        }
      }
      return [...unique.values()].slice(0, limit);
    },
    async listReconcileCandidates(now, limit) {
      if (
        !Number.isSafeInteger(now)
        || now < 0
        || !Number.isSafeInteger(limit)
        || limit <= 0
      ) {
        throw new TypeError('reconciliation query bounds are invalid');
      }
      const common = {
        schemaVersion: 2,
        orderStatus: 'awaiting_payment',
        paymentStatus: 'unpaid',
        'paymentClaim.nextReconcileAt': db.command.lte(now)
      };
      const query = (paymentState) => db.collection('shop_orders')
        .where({
          ...common,
          ...paymentState
        })
        .orderBy('paymentClaim.nextReconcileAt', 'asc')
        .orderBy('paymentClaim.claimedAt', 'asc')
        .orderBy('_id', 'asc')
        .limit(limit)
        .get();
      const pages = await Promise.all([
        query({ 'paymentClaim.status': 'uncertain' }),
        query({
          'paymentClaim.status': 'creating',
          'paymentClaim.leaseExpiresAt': db.command.lte(now)
        }),
        query({
          'paymentClaim.status': 'prepay_ready',
          prepayExpiresAt: db.command.lte(now)
        })
      ]);
      const unique = new Map();
      for (const page of pages) {
        for (const order of listData(page)) {
          if (!order || typeof order._id !== 'string' || !order._id) {
            throw new Error('reconciliation query returned an invalid order ID');
          }
          if (!unique.has(order._id)) unique.set(order._id, order);
        }
      }
      return [...unique.values()].sort((left, right) => {
        const leftNextReconcileAt = left.paymentClaim
          && Number.isSafeInteger(left.paymentClaim.nextReconcileAt)
          ? left.paymentClaim.nextReconcileAt
          : Number.MAX_SAFE_INTEGER;
        const rightNextReconcileAt = right.paymentClaim
          && Number.isSafeInteger(right.paymentClaim.nextReconcileAt)
          ? right.paymentClaim.nextReconcileAt
          : Number.MAX_SAFE_INTEGER;
        const leftClaimedAt = left.paymentClaim
          && Number.isSafeInteger(left.paymentClaim.claimedAt)
          ? left.paymentClaim.claimedAt
          : Number.MAX_SAFE_INTEGER;
        const rightClaimedAt = right.paymentClaim
          && Number.isSafeInteger(right.paymentClaim.claimedAt)
          ? right.paymentClaim.claimedAt
          : Number.MAX_SAFE_INTEGER;
        return leftNextReconcileAt - rightNextReconcileAt
          || leftClaimedAt - rightClaimedAt
          || left._id.localeCompare(right._id);
      }).slice(0, limit);
    },
    runTransaction(work) {
      return db.runTransaction((transaction) => (
        work(createTransactionStore(transaction))
      ));
    },
    serverDate() {
      return db.serverDate();
    }
  });
}

module.exports = {
  createCloudbasePaymentStore
};
