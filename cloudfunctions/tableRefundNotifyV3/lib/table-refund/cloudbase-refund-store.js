'use strict';

function optionalData(result) {
  return result && result.data ? result.data : null;
}

function listData(result) {
  return result && Array.isArray(result.data) ? result.data : [];
}

function createTransactionStore(source) {
  return {
    async getWechatBinding(id) {
      return optionalData(await source.collection('wechat_bindings').doc(id).get());
    },
    async getAccount(id) {
      return optionalData(await source.collection('accounts').doc(id).get());
    },
    async getUser(id) {
      return optionalData(await source.collection('users').doc(id).get());
    },
    async getOrder(id) {
      return optionalData(await source.collection('shop_orders').doc(id).get());
    },
    async getRefund(id) {
      return optionalData(await source.collection('shop_refunds').doc(id).get());
    },
    async getFinancialEvent(id) {
      return optionalData(await source.collection('financial_events').doc(id).get());
    },
    async updateOrder(id, data) {
      await source.collection('shop_orders').doc(id).update({ data });
    },
    async setRefund(id, document) {
      await source.collection('shop_refunds').doc(id).set({
        data: { _id: id, ...document }
      });
    },
    async updateRefund(id, data) {
      await source.collection('shop_refunds').doc(id).update({ data });
    },
    async setFinancialEvent(id, document) {
      await source.collection('financial_events').doc(id).set({
        data: { _id: id, ...document }
      });
    }
  };
}

function createCloudbaseRefundStore(db) {
  if (
    !db
    || typeof db.collection !== 'function'
    || typeof db.runTransaction !== 'function'
    || typeof db.serverDate !== 'function'
    || !db.command
    || typeof db.command.lte !== 'function'
    || typeof db.command.exists !== 'function'
  ) {
    throw new TypeError('CloudBase database is required');
  }
  return Object.freeze({
    async listDueRefunds(now, limit) {
      if (
        !Number.isSafeInteger(now)
        || now < 0
        || !Number.isSafeInteger(limit)
        || limit <= 0
      ) throw new TypeError('refund recovery query bounds are invalid');
      const query = (status, due, virgin) => {
        let request = db.collection('shop_refunds').where({
          schemaVersion: 1,
          status,
          refundNextAttemptAt: due,
          ...(virgin
            ? { 'refundClaim.leaseExpiresAt': db.command.lte(now) }
            : {})
        });
        request = request.orderBy(
          virgin ? 'refundClaim.leaseExpiresAt' : 'refundNextAttemptAt',
          'asc'
        );
        return request
          .orderBy('requestedAt', 'asc')
          .orderBy('_id', 'asc')
          .limit(limit)
          .get();
      };
      const pages = await Promise.all(['returning', 'processing'].flatMap(
        (status) => [
          query(status, db.command.lte(now), false),
          query(status, db.command.exists(false), true)
        ]
      ));
      const unique = new Map();
      for (const page of pages) {
        for (const refund of listData(page)) {
          if (!refund || typeof refund._id !== 'string' || !refund._id) {
            throw new Error('refund recovery query returned an invalid ID');
          }
          if (!unique.has(refund._id)) unique.set(refund._id, refund);
        }
      }
      return [...unique.values()].sort((left, right) => {
        const leftDue = Number.isSafeInteger(left.refundNextAttemptAt)
          ? left.refundNextAttemptAt
          : left.refundClaim && left.refundClaim.leaseExpiresAt;
        const rightDue = Number.isSafeInteger(right.refundNextAttemptAt)
          ? right.refundNextAttemptAt
          : right.refundClaim && right.refundClaim.leaseExpiresAt;
        const leftRequested = Number.isSafeInteger(left.requestedAt)
          ? left.requestedAt
          : Number.MAX_SAFE_INTEGER;
        const rightRequested = Number.isSafeInteger(right.requestedAt)
          ? right.requestedAt
          : Number.MAX_SAFE_INTEGER;
        return leftDue - rightDue
          || leftRequested - rightRequested
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
  createCloudbaseRefundStore
};
