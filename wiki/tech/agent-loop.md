# AgentLoop

一般来说，一个Agent仅靠一来一回这样的交互是很难完成一件工作的.基本需要识别提示词后，对现有环境进行分析，然后调用工具，操作文件等等多轮交互，最后再来返回结果。于是每个Agent都会设计自己的Agent Loop，此处以pi为例，讲述好的AgentLoop为什么这么重要。

## 本质

有一个悲观的角度来说，人生本质也就是一场Loop。其中有两个循环，一个是外部会给你引发的条件，一个是你内部现在是在如何做一件事情。我们称之为内外loop。

```
while(外部条件)//such as 考试，找工作，做任务
{
	while(内部条件)//such as 这件事做完了吗？
	{
	
	}
}
```

## pi的agent-loop

```tsx
async function runLoop(
	initialContext: AgentContext,	//非常简单，消息与工具的集合
     newMessages:AgentMessage[],	//各种类型新消息的抽象
     initialConfig:AgentLoopConfig,	//循环配置是缓存的
     signal:AbortSingnal|undefined,	//中断信号
     emit:AgentEventSink,			//事件通知器
     streamFunction:StreamFn,		//流式输出器
): Promise<void>{
        let currentContext = initialContext;
        let config = initialConfig;
        let lastCompletedTurn: PrepareNextTurnContext | undefined;	//刚完成的信息,用于交付给下一轮
        let pendingMessages:AgentMessage[] = (await config.getSteeringMessages?.()) || [];//steering机制
        
        while(true){	//一轮Run
            let hasMoreToolCalls:true;
            // 下列也就是一轮对话，称为Turn，粒度为大模型的一次响应。
            while(hasMoreToolCalls || pendingMessages.length >0){	//若还需要工具调用或者有插队消息，继续执行
                if(lastCompletedTurn){
                    const nextTurnSnapshot = await config.prepareNextTurn?.(lastCompletedTurn);
                    if(nextTurnSnapshot){
                        currentContext = nextTurnSnapshot.context ?? currentContext;
                        config = {
                            ...config,	//覆盖,重新装配mdoel和thinkinglevel
                            model:nextTurnSnapshot.model ?? config,model,
                            reasoning:
                            nextTurnSnapshot.thinkingLevel === undefined?config.reasoning:nextTurnSnapshot.thinkingLevel === "off"? undefined:nextTurnSnapshot.thinkingLevel,
                        };
                    }
                    if(pendingMessages.length==0){	//最后检查是否有插队消息
                        pendingMessages = (await config.getSteeringMessages?.()) || [];
                    }
                    await emit({type:"turn_start"});
                }
                if(pendingMessages.length>0){	//由于装配下一轮需要时间，此处可能又有插队消息
                            for(const message of pendingMessages){
                                //此处start跟end设计便于一次性和流式输出并存，流式输出还会有update。
                                await emit({type:"message_start",message});
                                await emit({type:"message_end",message});
                                currentContext.messages.push(message);
                                newMessages.push(message);
                            }
                    pendingMessages = [];
                }
                
                // 获取AI响应
                const message = await streamAssistantResponse(currentContext,config,signal,emit,streamFunction);
                newMessages.push(message);
                
                if(message.stopReason === "error" || message.stopReason === "aborted"){
                    await emit({type:"turn_end",message,toolResults:[]});
                    await emit({type:"agent_end",message:newMessages});
                    return;
                }
                // 从AI响应中提取需要调用工具部分
                const toolCalls = message.content.filter((c)=>c.type === "toolCall");
                const toolResults:ToolResultMessage[] = [];
                hasMoreToolCalls = false;
                if(toolCalls.length > 0){
                    const executedToolBatch = 
                          message.stopReason === "length"
                    ? await failToolCallsFromTruncatedMessage(toolCalls,emit)
                    : await executeToolCalls(currentContext,message,config,signal,emit);
                    toolResults.push(...executedToolBatch.messages);
                    hasMoreToolCalls = !executedToolBatch.terminate;
                    
                    for(const result of toolResults){
                        currentContext.messages.push(result);
                        newMessages.push(result);
                    }
                }
                
                await emit({type:"turn_end",message,toolResults});
                
                lastCompletedTurn = {
                    message,
                    toolResults,
                    context:currentContext,
                    newMessages,
                };
                
                if(await config.shouldStopAfterTurn?.(lastCompletedTurn)){
                    await emit({type:"agent_end",messages:newMessages});
                    return;
                }
                pendingMessages = (await config.getSteeringMessages?.()) || [];
            }
            const followUpMessages = (await config.getSteeringMessages?.()) || [];
            if(followUpMessages.length > 0){
                pendingMessages = followUpMessages;
                continue;
            }
            break;
        }
        await emit({type:"agent_end",messages:newMessages});
    }
```

pi的Agent Loop不到100行，却有很多设计哲学。

第一个当属它对于这个Event的运用，就是我们一个它把我们和AI的交互分为四个层级，最外层的是**Run**，也就是相当于一轮完整的人类与AI的对话，或者说人类发出指令，到AI完成这项指令的任务。往里一层是**Turn**，也就是一轮。一轮的粒度是LLMAPI的一轮响应。也就是说，通过请求AI之后的一次响应，并且包含回答，工具调用等等信息。再往里就是**Message**，也就是AI给出它的回答。那么这里除了start跟end还支持update。它可以兼容这个流式输出。与Message并列的还有**Tool Execute**，它同样支持update，也就是兼容流式输出。所以这是，在对Agent的信息的一些归纳总结，我们能够在Agent Event找到它。

第二个值得关注的就是上下文管理。一般情况下我们设计loop的时候经常会将一个上下文窗口做维护。然后无论是用户的请求啊，还是AI的响应，亦或是工具调用，都会添加到上下文。我们要如何去持久化每一条真实的请求与响应，又如何动态地提供给Agent一个高效的窗口？此处pi的设计值得思考，他将上下文以及每一个Agent轮的实际产物解耦。使用了一个context去作为上下文窗口。同时它为每一轮，这一轮指的是agent这一轮。去提供了new messages数组。这样的好处在于，我每一轮的信息展示，或者说持久化，都可以通过这个new message去做。而context它是非常动态的。

此处还有一个可能会产生疑惑的地方是，Last completed turn还有Current context。 Current context无疑是上下文窗口。那我们last completed turn里面还维护了message、 tool results还有new messages。那为什么这样呢？其实我们得先想本质。从前面说到的粒度，那无非是 run turn以及turn里面的AI的行为。那我们一份 context，它其实是在一个很多轮的run里面去动态地调整维护的。所以context其实是中间态。那如果我们一直维护着一个动态的context就很难去区别turn之间的关系。于是乎我们引出last completed turn就是为了在这个粒度下有一个引用维护。

```tsx
lastCompletedTurn = {
    message,		//ai回复
    toolResults,	//工具调用结果
    context: currentContext,
    newMessages,	//本run产物
};
```

可以看到Last completed turn除了维护当前的上下文窗口之外，也维护了本turn的message还有tool results。同时也维护了本run的new messages，因此。我们可以很简单的通过钩子去对last completed turn去做。不同的操作，而不是具体到context、 message、 tool results这一些更加细粒度的东西。所以这里设计的哲学就是用turn去给它维护上一轮的状态。同时我们可以更容易地用钩子去操作。