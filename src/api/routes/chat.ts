import _ from 'lodash';

import Request from '@/lib/request/Request.ts';
import Response from '@/lib/response/Response.ts';
import { tokenSplit } from '@/api/controllers/core.ts';
import { createCompletion, createCompletionStream } from '@/api/controllers/chat.ts';
import { selectToken, estimateCredits } from '@/lib/load-balancer.ts';

export default {

    prefix: '/v1/chat',

    post: {

        '/completions': async (request: Request) => {
            request
                .validate('body.model', v => _.isUndefined(v) || _.isString(v))
                .validate('body.messages', _.isArray)
                .validate('headers.authorization', _.isString)
            const tokens = tokenSplit(request.headers.authorization);
            const { model, messages, stream } = request.body;

            // 积分感知选择 token
            const isVideo = model && model.startsWith('jimeng-video');
            const estimatedCost = isVideo
              ? estimateCredits('video', { model, duration: 5 })
              : estimateCredits('image', { resolution: '2k', count: 4 });
            const token = await selectToken(tokens, estimatedCost, isVideo ? 'highest' : 'drain-low');
            if (stream) {
                const stream = await createCompletionStream(messages, token, model);
                return new Response(stream, {
                    type: "text/event-stream"
                });
            }
            else
                return await createCompletion(messages, token, model);
        }

    }

}
