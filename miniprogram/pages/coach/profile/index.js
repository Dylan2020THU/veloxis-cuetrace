const data = require('../../../services/data');
const billing = require('../../../utils/billing');

const TRIAL_DAY_MS = 24 * 60 * 60 * 1000;

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

const PINYIN_MAP = {
  阿: 'A', 埃: 'A', 艾: 'A', 爱: 'A', 安: 'A', 奥: 'A',
  八: 'B', 巴: 'B', 白: 'B', 百: 'B', 部: 'B', 拜: 'B', 柏: 'B', 板: 'B', 半: 'B', 包: 'B', 保: 'B', 宝: 'B', 报: 'B', 暴: 'B',
  北: 'B', 贝: 'B', 必: 'B', 碧: 'B', 博: 'B', 搏: 'B', 步: 'B',
  才: 'C', 财: 'C', 川: 'C', 彩: 'C', 菜: 'C', 苍: 'C', 操: 'C', 潮: 'C', 车: 'C', 陈: 'C', 成: 'C', 城: 'C', 赤: 'C', 初: 'C', 楚: 'C', 创: 'C', 垂: 'C', 春: 'C', 磁: 'C', 翠: 'C',
  大: 'D', 带: 'D', 丹: 'D', 岛: 'D', 道: 'D', 灯: 'D', 登: 'D', 迪: 'D', 第: 'D', 顶: 'D', 东: 'D', 动: 'D', 斗: 'D', 都: 'D', 独: 'D', 端: 'D', 段: 'D', 对: 'D',
  二: 'E', 俄: 'E', 恩: 'E',
  发: 'F', 番: 'F', 凡: 'F', 反: 'F', 方: 'F', 飞: 'F', 非: 'F', 肥: 'F', 纷: 'F', 丰: 'F', 风: 'F', 枫: 'F', 福: 'F', 辅: 'F',
  嘎: 'G', 改: 'G', 干: 'G', 感: 'G', 高: 'G', 歌: 'G', 格: 'G', 根: 'G', 工: 'G', 功: 'G', 供: 'G', 宫: 'G', 拱: 'G', 共: 'G', 沟: 'G', 固: 'G', 顾: 'G', 挂: 'G', 关: 'G', 观: 'G', 馆: 'G', 冠: 'G', 广: 'G', 贵: 'G', 国: 'G', 果: 'G', 过: 'G',
  海: 'H', 韩: 'H', 汉: 'H', 航: 'H', 合: 'H', 何: 'H', 和: 'H', 河: 'H', 黑: 'H', 横: 'H', 红: 'H', 洪: 'H', 厚: 'H', 湖: 'H', 虎: 'H', 沪: 'H', 花: 'H', 华: 'H', 淮: 'H', 环: 'H', 黄: 'H', 回: 'H', 辉: 'H', 汇: 'H', 徽: 'H', 惠: 'H', 慧: 'H', 火: 'H', 活: 'H',
  基: 'J', 击: 'J', 俱: 'J', 机: 'J', 激: 'J', 极: 'J', 吉: 'J', 即: 'J', 济: 'J', 记: 'J', 技: 'J', 季: 'J', 继: 'J', 佳: 'J', 家: 'J', 甲: 'J', 贾: 'J', 简: 'J', 建: 'J', 健: 'J', 剑: 'J', 鉴: 'J', 江: 'J', 姜: 'J', 将: 'J', 蒋: 'J', 交: 'J', 焦: 'J', 角: 'J', 教: 'J', 街: 'J', 节: 'J', 洁: 'J', 解: 'J', 金: 'J', 锦: 'J', 近: 'J', 进: 'J', 京: 'J', 经: 'J', 精: 'J', 景: 'J', 静: 'J', 镜: 'J', 酒: 'J', 久: 'J', 聚: 'J', 巨: 'J', 军: 'J', 均: 'J',
  开: 'K', 康: 'K', 考: 'K', 科: 'K', 可: 'K', 克: 'K', 孔: 'K', 口: 'K', 快: 'K', 狂: 'K',
  拉: 'L', 来: 'L', 莱: 'L', 蓝: 'L', 浪: 'L', 老: 'L', 乐: 'L', 雷: 'L', 垒: 'L', 泪: 'L', 冷: 'L', 黎: 'L', 力: 'L', 历: 'L', 立: 'L', 丽: 'L', 利: 'L', 连: 'L', 良: 'L', 两: 'L', 量: 'L', 林: 'L', 临: 'L', 淋: 'L', 灵: 'L', 凌: 'L', 零: 'L', 领: 'L', 流: 'L', 刘: 'L', 留: 'L', 龙: 'L', 楼: 'L', 卢: 'L', 鲁: 'L', 路: 'L', 旅: 'L', 绿: 'L', 乱: 'L', 轮: 'L', 洛: 'L', 律: 'L',
  马: 'M', 麦: 'M', 满: 'M', 慢: 'M', 芒: 'M', 冒: 'M', 梅: 'M', 美: 'M', 门: 'M', 梦: 'M', 弥: 'M', 米: 'M', 密: 'M', 免: 'M', 民: 'M', 明: 'M', 鸣: 'M', 莫: 'M', 墨: 'M', 木: 'M', 幕: 'M',
  那: 'N', 南: 'N', 娜: 'N', 能: 'N', 尼: 'N', 你: 'N', 年: 'N', 念: 'N', 宁: 'N', 牛: 'N', 农: 'N', 努: 'N', 女: 'N', 暖: 'N',
  欧: 'O', 偶: 'O',
  排: 'P', 佩: 'P', 鹏: 'P', 皮: 'P', 片: 'P', 漂: 'P', 平: 'P', 普: 'P', 浦: 'P',
  七: 'Q', 期: 'Q', 其: 'Q', 奇: 'Q', 企: 'Q', 起: 'Q', 气: 'Q', 器: 'Q', 千: 'Q', 前: 'Q', 潜: 'Q', 强: 'Q', 墙: 'Q', 巧: 'Q', 青: 'Q', 轻: 'Q', 清: 'Q', 晴: 'Q', 情: 'Q', 球: 'Q', 求: 'Q', 区: 'Q', 曲: 'Q', 去: 'Q', 全: 'Q', 泉: 'Q', 群: 'Q',
  然: 'R', 让: 'R', 热: 'R', 任: 'R', 日: 'R', 容: 'R', 如: 'R', 锐: 'R', 弱: 'R',
  三: 'S', 色: 'S', 森: 'S', 沙: 'S', 筛: 'S', 山: 'S', 善: 'S', 商: 'S', 上: 'S', 尚: 'S', 少: 'S', 社: 'S', 深: 'S', 神: 'S', 胜: 'S', 师: 'S', 十: 'S', 时: 'S', 实: 'S', 世: 'S', 市: 'S', 示: 'S', 室: 'S', 是: 'S', 适: 'S', 收: 'S', 首: 'S', 寿: 'S', 树: 'S', 双: 'S', 水: 'S', 顺: 'S', 思: 'S', 私: 'S', 四: 'S', 松: 'S', 素: 'S', 速: 'S', 酸: 'S', 随: 'S', 岁: 'S', 所: 'S',
  他: 'T', 台: 'T', 太: 'T', 态: 'T', 谈: 'T', 汤: 'T', 糖: 'T', 特: 'T', 体: 'T', 天: 'T', 添: 'T', 田: 'T', 庭: 'T', 通: 'T', 同: 'T', 统: 'T', 投: 'T', 头: 'T', 透: 'T', 土: 'T', 团: 'T', 推: 'T', 退: 'T', 托: 'T',
  外: 'W', 弯: 'W', 玩: 'W', 晚: 'W', 万: 'W', 王: 'W', 网: 'W', 往: 'W', 威: 'W', 微: 'W', 为: 'W', 维: 'W', 伟: 'W', 卫: 'W', 位: 'W', 文: 'W', 我: 'W', 卧: 'W', 握: 'W', 乌: 'W', 无: 'W', 五: 'W', 武: 'W', 舞: 'W', 物: 'W',
  希: 'X', 西: 'X', 息: 'X', 喜: 'X', 系: 'X', 细: 'X', 下: 'X', 夏: 'X', 先: 'X', 纤: 'X', 现: 'X', 线: 'X', 限: 'X', 陷: 'X', 相: 'X', 香: 'X', 向: 'X', 象: 'X', 像: 'X', 小: 'X', 校: 'X', 效: 'X', 斜: 'X', 心: 'X', 新: 'X', 星: 'X', 兴: 'X', 行: 'X', 形: 'X', 型: 'X', 醒: 'X', 姓: 'X', 修: 'X', 秀: 'X', 袖: 'X', 徐: 'X', 许: 'X', 轩: 'X', 学: 'X', 雪: 'X', 血: 'X',
  压: 'Y', 雅: 'Y', 亚: 'Y', 烟: 'Y', 延: 'Y', 严: 'Y', 岩: 'Y', 沿: 'Y', 眼: 'Y', 演: 'Y', 阳: 'Y', 杨: 'Y', 养: 'Y', 仰: 'Y', 氧: 'Y', 样: 'Y', 摇: 'Y', 遥: 'Y', 野: 'Y', 夜: 'Y', 业: 'Y', 叶: 'Y', 液: 'Y', 一: 'Y', 医: 'Y', 宜: 'Y', 移: 'Y', 遗: 'Y', 乙: 'Y', 已: 'Y', 以: 'Y', 艺: 'Y', 易: 'Y', 意: 'Y', 溢: 'Y', 翼: 'Y', 因: 'Y', 音: 'Y', 银: 'Y', 引: 'Y', 印: 'Y', 英: 'Y', 影: 'Y', 映: 'Y', 永: 'Y', 涌: 'Y', 泳: 'Y', 勇: 'Y', 用: 'Y', 优: 'Y', 油: 'Y', 游: 'Y', 友: 'Y', 有: 'Y', 右: 'Y', 又: 'Y', 幼: 'Y', 鱼: 'Y', 雨: 'Y', 语: 'Y', 玉: 'Y', 域: 'Y', 预: 'Y', 豫: 'Y', 元: 'Y', 原: 'Y', 圆: 'Y', 袁: 'Y', 源: 'Y', 远: 'Y', 院: 'Y', 月: 'Y', 越: 'Y', 云: 'Y', 运: 'Y',
  在: 'Z', 再: 'Z', 早: 'Z', 泽: 'Z', 曾: 'Z', 增: 'Z', 扎: 'Z', 闸: 'Z', 乍: 'Z', 展: 'Z', 占: 'Z', 战: 'Z', 张: 'Z', 长: 'Z', 掌: 'Z', 丈: 'Z', 找: 'Z', 照: 'Z', 兆: 'Z', 赵: 'Z', 针: 'Z', 镇: 'Z', 正: 'Z', 郑: 'Z', 政: 'Z', 之: 'Z', 支: 'Z', 执: 'Z', 直: 'Z', 值: 'Z', 职: 'Z', 只: 'Z', 纸: 'Z', 指: 'Z', 至: 'Z', 致: 'Z', 制: 'Z', 智: 'Z', 中: 'Z', 忠: 'Z', 钟: 'Z', 终: 'Z', 众: 'Z', 重: 'Z', 周: 'Z', 洲: 'Z', 珠: 'Z', 株: 'Z', 竹: 'Z', 主: 'Z', 驻: 'Z', 柱: 'Z', 祝: 'Z', 注: 'Z', 专: 'Z', 转: 'Z', 装: 'Z', 追: 'Z', 准: 'Z', 资: 'Z', 子: 'Z', 紫: 'Z', 字: 'Z', 宗: 'Z', 走: 'Z', 租: 'Z', 足: 'Z', 族: 'Z', 组: 'Z', 祖: 'Z', 左: 'Z', 作: 'Z', 坐: 'Z', 做: 'Z', 座: 'Z'
};

function getPinyinInitials(name) {
  if (!name) return 'X';
  let result = '';
  for (const ch of name) {
    const upper = PINYIN_MAP[ch];
    if (upper) result += upper;
  }
  return result || 'X';
}

function generateCoachId(hallName) {
  const prefix = getPinyinInitials(hallName);
  const num = Math.floor(10000 + Math.random() * 90000);
  return `${prefix}${num}`;
}

Page({
  behaviors: [require('../../../utils/themeBehavior')],
  data: {
    weekdays: WEEKDAYS,
    avatar: '',
    nickname: '',
    playYears: '',
    coachYears: '',
    intro: '',
    pricePerMinute: '',
    certificates: [],
    availability: [],
    hallList: [],
    selectedHallId: '',
    selectedHallName: '',
    coachId: '',
    slotWeekday: 0,
    slotStart: '18:00',
    slotEnd: '21:00',
    submitting: false,
    // 试期状态（教练端）
    plan: 'free',
    trialDays: 0,
    trialActive: false
  },

  onLoad() {
    this.loadHalls();
    this.loadBilling();
    data.getCoachProfile().then((p) => {
      if (!p) return;
      this.setData({
        avatar: p.avatar || '',
        nickname: p.nickname || '',
        playYears: p.playYears || '',
        coachYears: p.coachYears || '',
        intro: p.intro || '',
        pricePerMinute: p.pricePerMinute || '',
        certificates: p.certificates || [],
        availability: p.availability || [],
        selectedHallId: p.hallId || '',
        selectedHallName: p.hallName || '',
        coachId: p.coachId || ''
      });
    });
  },

  loadHalls() {
    data.getHalls().then((halls) => {
      this.setData({ hallList: halls || [] });
    });
  },

  // 加载试期 / 套餐状态（顶部提示用）
  loadBilling() {
    data.getUserBilling().then((b) => {
      if (!b) return;
      const planKey = b.plan || 'free';
      const trialMs = b.trialRemainingMs || 0;
      this.setData({
        plan: planKey,
        trialDays: trialMs > 0 ? Math.ceil(trialMs / TRIAL_DAY_MS) : 0,
        trialActive: billing.isInTrial()
      });
    }).catch((err) => {
      console.warn('[教练资料] 拉取计费状态失败', err);
    });
  },

  // 试期外+免费版：点顶部 banner 触发付费墙
  onOpenCoachPaywall() {
    const app = getApp();
    app.paywall({
      feature: '',
      planKey: 'coach_pro',
      role: 'coach',
      multi: true,
      from: 'coach_profile'
    }, (ok) => {
      if (ok) this.loadBilling();
    });
  },

  onHallChange(e) {
    const idx = Number(e.detail.value);
    const hall = this.data.hallList[idx];
    if (!hall) return;
    const hallName = hall.name || '';
    this.setData({
      selectedHallId: hall._id || hall.hallId || '',
      selectedHallName: hallName,
      coachId: generateCoachId(hallName)
    });
  },

  onInput(e) {
    const field = e.currentTarget.dataset.field;
    this.setData({ [field]: e.detail.value });
  },

  chooseAvatar() {
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      success: (res) => {
        const tempPath = res.tempFiles[0].tempFilePath;
        wx.showLoading({ title: '上传中' });
        data
          .uploadImage(tempPath)
          .then((url) => this.setData({ avatar: url }))
          .finally(() => wx.hideLoading());
      }
    });
  },

  chooseCertificate() {
    const remain = 6 - this.data.certificates.length;
    if (remain <= 0) {
      wx.showToast({ title: '最多 6 张', icon: 'none' });
      return;
    }
    wx.chooseMedia({
      count: remain,
      mediaType: ['image'],
      success: (res) => {
        const paths = res.tempFiles.map((f) => f.tempFilePath);
        wx.showLoading({ title: '上传中' });
        Promise.all(paths.map((p) => data.uploadImage(p)))
          .then((urls) => {
            this.setData({ certificates: this.data.certificates.concat(urls) });
          })
          .finally(() => wx.hideLoading());
      }
    });
  },

  removeCertificate(e) {
    const idx = e.currentTarget.dataset.index;
    const certificates = this.data.certificates.slice();
    certificates.splice(idx, 1);
    this.setData({ certificates });
  },

  previewCertificate(e) {
    const idx = e.currentTarget.dataset.index;
    wx.previewImage({ current: this.data.certificates[idx], urls: this.data.certificates });
  },

  onSlotWeekday(e) {
    this.setData({ slotWeekday: Number(e.detail.value) });
  },
  onSlotStart(e) {
    this.setData({ slotStart: e.detail.value });
  },
  onSlotEnd(e) {
    this.setData({ slotEnd: e.detail.value });
  },

  addSlot() {
    const { slotWeekday, slotStart, slotEnd } = this.data;
    if (slotStart >= slotEnd) {
      wx.showToast({ title: '结束需晚于开始', icon: 'none' });
      return;
    }
    const slot = {
      weekday: slotWeekday,
      weekdayLabel: WEEKDAYS[slotWeekday],
      start: slotStart,
      end: slotEnd
    };
    this.setData({ availability: this.data.availability.concat(slot) });
  },

  removeSlot(e) {
    const idx = e.currentTarget.dataset.index;
    const availability = this.data.availability.slice();
    availability.splice(idx, 1);
    this.setData({ availability });
  },

  submit() {
    if (this.data.submitting) return;
    const { nickname, intro, pricePerMinute } = this.data;
    if (!nickname) {
      wx.showToast({ title: '请填写昵称', icon: 'none' });
      return;
    }
    if (!pricePerMinute || Number(pricePerMinute) <= 0) {
      wx.showToast({ title: '请填写收费标准', icon: 'none' });
      return;
    }

    this.setData({ submitting: true });
    data
      .saveCoachProfile({
        nickname,
        playYears: this.data.playYears,
        coachYears: this.data.coachYears,
        avatar: this.data.avatar,
        certificates: this.data.certificates,
        intro,
        availability: this.data.availability,
        pricePerMinute,
        hallId: this.data.selectedHallId,
        hallName: this.data.selectedHallName,
        coachId: this.data.coachId
      })
      .then(() => {
        wx.showToast({ title: '已保存', icon: 'success' });
        setTimeout(() => wx.navigateBack(), 600);
      })
      .catch((err) => {
        console.error('保存教练资料失败', err);
        wx.showToast({ title: '保存失败', icon: 'none' });
      })
      .finally(() => this.setData({ submitting: false }));
  }
});
