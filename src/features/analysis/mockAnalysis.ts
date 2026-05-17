import type { AnalysisResult } from "../../types";

export function createMockAnalysis(duration: number): AnalysisResult {
  const safeDuration = Number.isFinite(duration) && duration > 0 ? Math.round(duration) : 45;

  return {
    basicInfo: {
      duration: safeDuration,
      topicType: "分级概念",
      materialType: "人工优化",
      targetAudience: "35岁+女性 / 有染烫修护需求",
      priorityLevel: "P0：人工优化 × 分级概念"
    },
    narrative: {
      hook: {
        range: "0-3秒",
        actual: "首帧用发质前后差异做强对比，字幕直接抛出头发状态分级。",
        type: "结果式 / 视觉冲击",
        rating: "有效",
        reason: "第一眼能看到结果差异，适合筛选真正关心发质修护的人群。",
        suggestions: ["把首帧字幕压缩到12字以内", "第一帧加入手指指向受损发尾"]
      },
      painPoint: {
        range: "3-10秒",
        actual: "展示染烫后干枯、毛躁、打结等具体场景。",
        type: "痛点场景",
        rating: "一般",
        reason: "痛点具体，但情绪强度还可以继续放大。",
        suggestions: ["加入梳不开头发的动作", "字幕突出「越护越塌」的反差"]
      },
      usp: {
        range: "10-20秒",
        actual: "以分级修护概念解释不同发质对应不同护理策略。",
        type: "分级概念",
        rating: "有效",
        reason: "差异化表达清楚，能避免泛泛讲功效。",
        suggestions: ["用三档标签强化记忆点", "把核心卖点做成一句话"]
      },
      trustProof: {
        range: "贯穿全程",
        actual: "包含前后对比和局部细节特写，但缺少权威背书。",
        type: "效果对比",
        rating: "一般",
        reason: "有视觉证据，但需要补一个可信来源来支撑转化。",
        suggestions: ["补充用户证言", "加入检测报告或成分背书"]
      },
      cta: {
        range: "最后5秒",
        actual: "结尾出现优惠信息，但购物车指引不够明确。",
        type: "限时优惠",
        rating: "一般",
        reason: "有购买理由，但缺少明确动作指令。",
        suggestions: ["加箭头指向购物车", "增加「今晚前拍」的紧迫感"]
      },
      completenessScore: "4/5段",
      rhythm: "前紧后松",
      structureIssue: "信任证明和CTA偏弱，可能影响转化率。",
      priority: "优先优化CTA和信任证明，再强化痛点段落。"
    },
    techniques: {
      visualStyle: "实拍 + 局部特写",
      pacing: "中等节奏，关键节点可加快切换",
      subtitles: "大字标题 + 逐句字幕",
      bgm: "轻节奏带货BGM",
      voice: "旁白",
      specialTechniques: "前后对比 / 局部特写 / 分级标签",
      highlights: ["首帧对比直接，能快速筛选目标用户", "分级概念适合延展成多条素材"],
      problems: ["CTA缺少购物车动作引导", "信任证明没有形成强背书"]
    },
    dataPrediction: {
      rows: [
        { metric: "3秒播放率", predicted: "24%", standard: "20-30%", passed: true },
        { metric: "10秒播放率", predicted: "11%", standard: "5-15%", passed: true },
        { metric: "转化率", predicted: "6.4%", standard: ">7%", passed: false },
        { metric: "完播率", predicted: "1.8%", standard: ">1%", passed: true },
        { metric: "整体点击率", predicted: "2.4%", standard: ">2%", passed: true }
      ],
      coreProbability: "中",
      biggestShortboard: "转化率可能卡在信任证明和CTA。",
      keyOptimization: "把信任元素前置，并把最后5秒改成明确购物车指令。"
    },
    executionPlan: {
      rewriteSegments: [
        {
          range: "0-3秒",
          content: "发尾炸毛和顺滑结果同屏对比。",
          reason: "首帧识别强，容易拉住目标人群。",
          direction: "保留对比框架，换成更夸张的发尾细节。"
        },
        {
          range: "10-20秒",
          content: "分级修护说明。",
          reason: "符合P0组合，适合继续裂变。",
          direction: "改成三档标签：毛躁、干枯、断发。"
        }
      ],
      replaceSegments: [
        {
          range: "最后5秒",
          current: "优惠信息露出但动作弱。",
          reason: "转化链路没有闭环。",
          replacement: "手指指向购物车 + 限时福利 + 一句话复述核心卖点。"
        }
      ],
      expansionPlans: {
        downCopy: "保留画面，替换为「染烫后别乱护，先看你是哪一级受损」文案，适用于35岁+女性。",
        downVisual: "保留文案，替换产品展示画面为浴室实拍和发尾微距。",
        downBgm: "保留画面和文案，替换为轻快但不抢人声的带货BGM。",
        upStrategy: "将当前「分级概念」扩展为「价格锚点」，突出一次护理成本对比。",
        upAudience: "将目标人群从35岁+女性扩展到染烫后修护人群，文案加入染发、烫发、漂发场景。"
      }
    },
    videoPrompts: {
      hookPrompt:
        "生成一个3秒的短视频开头。风格：抖音电商实拍、9:16竖屏。画面：左右分屏展示干枯炸毛发尾和顺滑发尾，第一帧强对比。文字：染烫后先看你是哪一级受损。要求：第一帧必须有视觉冲击力，3秒内抛出悬念。",
      painPointPrompt:
        "生成一个7秒的短视频片段。风格：真实浴室/梳妆台场景。画面：女性梳头时发尾打结、毛躁、发丝断裂，镜头给到手部和发尾特写。旁白：不是你不会护发，是你没先判断受损等级。要求：展示染烫后具体痛点场景，引发焦虑和共鸣。",
      uspPrompt:
        "生成一个10秒的短视频片段。风格：干净电商讲解。画面：把发质分成毛躁、干枯、断发三档，每档对应不同修护方案，产品在画面右侧清晰出现。旁白：不同受损等级，要用不同修护思路。要求：清晰展示产品分级修护差异化价值，与普通一瓶通用型护发形成对比。",
      trustPrompt:
        "生成一个8秒的短视频片段。风格：真实用户反馈。画面：用户使用前后发尾细节对比，加入局部放大框和真实评价字幕。旁白：看发尾顺滑度和毛躁变化，比只听功效更直接。要求：补足信任证明，突出真实效果对比。",
      ctaPrompt:
        "生成一个5秒的短视频结尾。风格：抖音电商直播切片感。画面：产品和顺滑发尾同框，手指指向左下角购物车位置。文字：今晚前拍，先测发质等级再护理。要求：有明确购买指令，手指指向左下角购物车位置，有紧迫感。"
    },
    summary:
      "这条视频最大的优势是首帧结果感强，最大的问题是信任和CTA没有完全闭环，最值得借鉴的是分级概念表达，优化后成为核心素材的概率预计从中提升至高。"
  };
}
