import {
    IMAGE_MODEL_MAP,
    IMAGE_MODEL_MAP_US,
    IMAGE_MODEL_MAP_ASIA,
    VIDEO_MODEL_MAP,
    VIDEO_MODEL_MAP_US,
    VIDEO_MODEL_MAP_ASIA,
} from '@/api/consts/common.ts';

// 各地区的模型映射表
const IMAGE_MAPS_BY_REGION: Record<string, Record<string, string>> = {
    CN: IMAGE_MODEL_MAP,
    US: IMAGE_MODEL_MAP_US,
    ASIA: IMAGE_MODEL_MAP_ASIA,
};

const VIDEO_MAPS_BY_REGION: Record<string, Record<string, string>> = {
    CN: VIDEO_MODEL_MAP,
    US: VIDEO_MODEL_MAP_US,
    ASIA: VIDEO_MODEL_MAP_ASIA,
};

/**
 * 从模型映射表汇总模型列表，附带各模型可用的地区
 * 新增模型只需更新 consts/common.ts 中的映射表，此处自动同步
 */
function collectModels(mapsByRegion: Record<string, Record<string, string>>, category: 'image' | 'video') {
    const regionsById = new Map<string, string[]>();
    for (const [region, modelMap] of Object.entries(mapsByRegion)) {
        for (const id of Object.keys(modelMap)) {
            const regions = regionsById.get(id);
            if (regions) {
                regions.push(region);
            } else {
                regionsById.set(id, [region]);
            }
        }
    }
    return [...regionsById.entries()].map(([id, regions]) => ({
        id,
        object: "model",
        owned_by: "jimeng-api",
        type: category,
        description: `即梦AI${category === 'video' ? '视频' : '图像'}生成模型（${regions.join('/')}站）`,
    }));
}

export default {

    prefix: '/v1',

    get: {
        '/models': async () => {
            return {
                "data": [
                    {
                        "id": "jimeng",
                        "object": "model",
                        "owned_by": "jimeng-api"
                    },
                    ...collectModels(IMAGE_MAPS_BY_REGION, 'image'),
                    ...collectModels(VIDEO_MAPS_BY_REGION, 'video'),
                ]
            };
        }

    }
}
