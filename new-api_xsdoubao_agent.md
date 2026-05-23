# 视频生成请求流程
##### Host: https://xxx.ai （xxx.ai 为举例，请根据实际站点域名替换）

##### 创建视频生成任务，得到{task_id}
https://apifox.newapi.ai/383844576e0
- 渠道的特殊字段要求（分辨率、多模态参考等）均通过 metadata json 字段透传。

##### 通过{task_id}查询视频生成任务状态
https://apifox.newapi.ai/383844577e0

##### 通过{task_id}下载视频
curl --location 'https://xxx.ai/v1/videos/{task_id}/content' \
--header 'Authorization: Bearer 密钥'

# Models
- xsdoubao/seedance2.0_fast_direct (生成时间不稳定)
- xsdoubao/seedance2.0_direct (生成时间不稳定)
- xsdoubao/seedance2.0_fast_vision
- xsdoubao/seedance2.0_vision

# NewAPI 计费说明
- xsdoubao/seedance2.0_fast_direct 720p 0.75 cny/秒
- xsdoubao/seedance2.0_direct 720p 1.05 cny/秒
- xsdoubao/seedance2.0_fast_vision 720p 0.912 cny/秒
- xsdoubao/seedance2.0_vision 720p 1.368 cny/秒
- xsdoubao/seedance2.0_vision 1080p 2.28 cny/秒


# 参考请求报文
- /v1/video/generations 接口

## xsDoubao
#### xsDoubao 文生视频 text-to-video
```json
{
  "model": "xsdoubao/seedance2.0_fast_vision",
  "prompt": "一个科幻风格的未来城市，飞行车在摩天大楼间穿梭，电影级光影",
  "metadata": {
    "ratio": "16:9",
    "duration": 5,
    "resolution": "720p"
  }
}
```

#### xsDoubao 图生视频 image-to-video
```json
{
  "model": "xsdoubao/seedance2.0_fast_vision",
  "prompt": "【@图片1】根据提示词动起来，电影级画质",
  "metadata": {
    "image_files": [
      "https://cdn-video.51sux.com/playground/20260201/d2b3ab39-8021-48bb-acb7-864dd5083464.png"
    ],
    "ratio": "9:16",
    "duration": 4,
    "resolution": "720p"
  }
}
```

#### xsDoubao 多模态参考 (image + audio)
- 提示词需使用「【@图片n】」、「【@音频n】」、「【@视频n】」等特定占位符引用素材。
- 音视频资源传参：需在 metadata 中的 `image_files`、`audio_files` 和 `video_files` 中以一维字符串数组的方式传递。

```json
{
  "model": "xsdoubao/seedance2.0_vision",
  "prompt": "【@图片1】根据【@音频1】的节奏跳舞，电影级光影",
  "metadata": {
    "image_files": [
      "https://cdn-video.51sux.com/playground/20260201/d2b3ab39-8021-48bb-acb7-864dd5083464.png"
    ],
    "audio_files": [
      "https://ark-project.tos-cn-beijing.volces.com/doc_audio/r2v_tea_audio1.mp3"
    ],
    "ratio": "16:9",
    "duration": 4,
    "resolution": "720p",
    "seed": 123456
  }
}
```

# Agent (claude code, cursor, antigravity, openclaw, opencode, codebuddy 等) 视频生成流程调用提示词
TIPS: agent 调用思路为，提供给 agent md 格式文档就能驱动 agent 开发。

#### xsDoubao:
```angular2html
newapi文档：
https://apifox.newapi.ai/llms.txt
具体模型特殊说明（xsDoubao渠道）：
1. 提示词中必须使用 【@图片1】、【@音频1】、【@视频1】格式引用对应的媒体资源。
2. 资源传参需放在 metadata 字段下的 image_files、audio_files、video_files 等字符串数组中。
3. 请使用特定的模型映射格式，如 xsdoubao/seedance2.0_vision 等。

下载视频：
curl --location 'https://xxx.ai/v1/videos/{task_id}/content' \
--header 'Authorization: Bearer 密钥'

阅读规则：
先阅读《newapi文档》文档，不能满足用例的特殊传参需求（如 resolution, 多媒体文件引用）通过 metadata json 字段透传过去。
NewAPI 的视频生成接口路径与 OpenAI 兼容格式不同，注意使用正确的《newapi文档》url路径。

总结上面和帮我写curl请求报文实现用例：
[] 1、创建视频生成任务: 提交视频生成任务，支持文生视频、图生视频、多模态参考视频。
[] 2、获取视频生成任务状态: 查询视频生成任务的状态和结果。
[] 3、下载视频

模型为：xsdoubao/seedance2.0_vision
场景为：多模态参考视频生成
host为：https://xxx.ai
```

- 创建视频任务传参遇到问题请群里沟通[玫瑰]
