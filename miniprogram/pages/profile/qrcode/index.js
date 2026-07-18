const data = require('../../../services/data');
const mock = require('../../../utils/mock');
const account = require('../../../utils/account');
const qrcode = require('../../../utils/qrcode');

const ROLE_LABEL = { member: '会员', coach: '教练', shop: '店家' };

Page({
  behaviors: [require('../../../utils/themeBehavior')],

  data: {
    nickname: '大川会员',
    avatar: '',
    roleLabel: '会员',
    accountCode: '',
    payload: ''
  },

  onLoad() {
    const app = getApp();
    const role = mock.getRole();
    const openid = (app.globalData && app.globalData.openid) || mock.MOCK_OPENID;
    const profile = (app.globalData && app.globalData.userProfile) || {};
    const code = account.codeOf(openid);
    // 店主端按「球厅」口吻显示标题
    if (role === 'shop') {
      wx.setNavigationBarTitle({ title: '球厅二维码' });
    }
    const base = {
      roleLabel: ROLE_LABEL[role] || '会员',
      accountCode: code,
      nickname: profile.nickname || '大川会员',
      avatar: profile.avatar || ''
    };
    const payload = account.buildPayload({ role, openid, code, name: base.nickname });
    this._openid = openid;
    this._code = code;
    this._payload = payload;
    this.setData(Object.assign({ payload }, base));
    this.renderQR(payload);

    // 异步补全云端资料（昵称/头像）；openid/code 不变，仅 name 可能变 → 必要时重绘
    data.getUserProfile().then((user) => {
      if (!user) return;
      const nextRole = user.role || role;
      const nickname = user.nickname || base.nickname;
      const newPayload = account.buildPayload({ role: nextRole, openid, code, name: nickname });
      this.setData({
        nickname,
        avatar: user.avatar || base.avatar,
        roleLabel: ROLE_LABEL[nextRole] || base.roleLabel,
        payload: newPayload
      });
      if (newPayload !== this._payload) {
        this._payload = newPayload;
        this.renderQR(newPayload);
      }
    }).catch(() => {});
  },

  // 取 canvas 节点并绘制（节点未就绪时重试一次）
  renderQR(payload) {
    const draw = (retry) => {
      const q = wx.createSelectorQuery();
      q.select('#qrcanvas').fields({ node: true, size: true }).exec((res) => {
        if (res && res[0] && res[0].node) {
          this._paint(res[0], payload);
        } else if (retry > 0) {
          setTimeout(() => draw(retry - 1), 80);
        }
      });
    };
    draw(3);
  },

  _paint(info, payload) {
    const canvas = info.node;
    const ctx = canvas.getContext('2d');
    let dpr = 2;
    try {
      dpr = (wx.getWindowInfo ? wx.getWindowInfo().pixelRatio : wx.getSystemInfoSync().pixelRatio) || 2;
    } catch (e) {}
    const size = info.width || 220;
    canvas.width = Math.floor(size * dpr);
    canvas.height = Math.floor(size * dpr);
    ctx.scale(dpr, dpr);

    const qr = qrcode(0, 'M');
    qr.addData(payload);
    qr.make();
    const count = qr.getModuleCount();
    const margin = Math.max(8, Math.floor(size * 0.04));
    const cell = (size - margin * 2) / count;

    // 白底黑码（不随夜间模式变化，保证可扫）
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = '#111111';
    for (let r = 0; r < count; r++) {
      for (let c = 0; c < count; c++) {
        if (qr.isDark(r, c)) {
          ctx.fillRect(margin + c * cell, margin + r * cell, Math.ceil(cell), Math.ceil(cell));
        }
      }
    }
  },

  copyCode() {
    if (!this.data.accountCode) return;
    wx.setClipboardData({
      data: this.data.accountCode,
      success: () => wx.showToast({ title: '编码已复制', icon: 'success' })
    });
  }
});
