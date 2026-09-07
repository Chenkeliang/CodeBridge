# 飞书附件

支持图片、普通文件、原生视频和音频消息。视频/音频通过官方消息资源接口的 type=file 下载；不会把视频封面当作视频本体。

常见格式：PDF；Word DOC/DOCX/RTF/ODT；Excel XLS/XLSX/ODS、CSV/TSV；TXT/Markdown/JSON/XML/YAML/HTML/日志；PPT/PPTX；MP4/MOV/WebM/MKV/AVI；MP3/M4A/WAV/OGG/Opus/AAC/FLAC/AMR；ZIP/RAR/7z/TAR/GZ。未知扩展名也按二进制文件保留，不因没有MIME映射而拒绝。

单文件和单条消息保留的附件总量均低于100 MB（100000000字节）。超过上限会明确提示，可压缩或拆分后重传。本实现不使用Range下载超大资源。下载过程中就检查上限，避免整个超大文件先进入内存。

PNG/JPEG/GIF/WebP可走原生图片输入；HEIC/TIFF/BMP/SVG等先交给本地转换工具。文档/表格/视频/音频原件保存为本地文件，并提供格式对应读取提示。收到文件不等于模型原生支持该格式：PDF、Word、表格需对应解析器，视频需抽帧/音轨，音频需转写工具；缺少工具、加密或损坏时会说明限制。不会自动执行附件中的宏、脚本或指令。

文件名会安全规范化，过长名称按UTF-8边界缩短，同名文件自动加编号，不互相覆盖。当前任务完成后临时原件会清理；需后续追问时，请本轮要求保存工作副本，或重新上传。

官方合同：https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message-resource/get
