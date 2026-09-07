# Attachment formats verification

Base8d489cd. Feishu ingress accepts video/audio as file resources and recognizes common document/media extensions. Unknown files retained. Bounded stream reads and aggregate accepted-message budget; duplicate/unsafe/long filenames protected. ACP and Pi receive typed quoted local paths with binary-tool guidance; unsupportednativeimageformats are treatedasfiles.

Surface matrix:
| Surface | entry/read/write/events | recovery/error/terminal | evidence |
|---|---|---|---|
| Feishu | message.resources -> messageResource.get -> Session attachments | per-resource failuresreported, oversizedstreamcancelled, attachment-onlyprompt fallback | downloadformat/bytebudgettests; liveupload pending at commit |
| Agent | materialize -> ACP/Pi prompt paths or nativeimages | collision-safe names, partialwritecleanup, formattools guidance | materialization + prompttests |
| Web | unchanged attachment Run contract | shared materializer and prompt behavior | fullregression |
| Telegram | existing file input, shared downstream materializer | same filenamesafety and formatguidance | fullregression; productiondisabled |

Review found255bytecollision suffix overflow; reproducedandfixed with boundedUTF8names and regressioncases. Originalbytespreserved. Fullbuild/tests and actualrelease evidence recorded externally under outputs/codebridge-attachment-fixtures. No automatic document converter or transcriptionservice is introduced; availableAgent tools analyze originalfiles. Tempattachmentsremain current-run-only.
