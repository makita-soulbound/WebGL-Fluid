'use strict';

(() => {
    const canvas = document.querySelector('.fluid-background__canvas');

    const simulation = {
        resolutionShift: 1,
        pigmentRetention: 0.955,
        motionRetention: 0.965,
        pressureRetention: 0.8,
        pressurePasses: 25,
        swirlStrength: 24,
        brushRadius: 0.0035
    };

    const backgroundInteraction = {
        enabled: new URLSearchParams(window.location.search).get('interaction') !== 'off',
        distortionStrength: 0.3
    };

    const blueGradient = [
        [0.72, 1.05, 1.28],
        [0.26, 0.78, 1.42],
        [0.06, 0.3, 1.45]
    ];

    function sampleBlueGradient(progress) {
        const normalized = Math.min(Math.max(progress, 0), 1);
        const scaled = normalized * (blueGradient.length - 1);
        const startIndex = Math.min(Math.floor(scaled), blueGradient.length - 2);
        const blend = scaled - startIndex;
        const start = blueGradient[startIndex];
        const end = blueGradient[startIndex + 1];

        return start.map((channel, index) => (
            channel + (end[index] - channel) * blend
        ));
    }

    const { gl, textureSupport } = createRenderingContext(canvas);

    function createRenderingContext(targetCanvas) {
        const contextOptions = {
            alpha: false,
            depth: false,
            stencil: false,
            antialias: false
        };

        let context = targetCanvas.getContext('webgl2', contextOptions);
        const usesWebGL2 = Boolean(context);

        if (!context) {
            context = targetCanvas.getContext('webgl', contextOptions)
                || targetCanvas.getContext('experimental-webgl', contextOptions);
        }

        if (!context) {
            throw new Error('WebGL is not supported by this browser.');
        }

        let halfFloatType;
        let linearHalfFloat;

        if (usesWebGL2) {
            context.getExtension('EXT_color_buffer_float');
            halfFloatType = context.HALF_FLOAT;
            linearHalfFloat = context.getExtension('OES_texture_float_linear');
        } else {
            const halfFloatExtension = context.getExtension('OES_texture_half_float');
            if (!halfFloatExtension) {
                throw new Error('Half-float textures are not supported by this browser.');
            }
            halfFloatType = halfFloatExtension.HALF_FLOAT_OES;
            linearHalfFloat = context.getExtension('OES_texture_half_float_linear');
        }

        context.clearColor(0, 0, 0, 1);

        const rgba = chooseRenderableFormat(
            context,
            usesWebGL2 ? context.RGBA16F : context.RGBA,
            context.RGBA,
            halfFloatType
        );
        const rg = chooseRenderableFormat(
            context,
            usesWebGL2 ? context.RG16F : context.RGBA,
            usesWebGL2 ? context.RG : context.RGBA,
            halfFloatType
        );
        const red = chooseRenderableFormat(
            context,
            usesWebGL2 ? context.R16F : context.RGBA,
            usesWebGL2 ? context.RED : context.RGBA,
            halfFloatType
        );

        if (!rgba || !rg || !red) {
            throw new Error('Required render texture formats are unavailable.');
        }

        return {
            gl: context,
            textureSupport: {
                rgba,
                rg,
                red,
                halfFloatType,
                linearFiltering: Boolean(linearHalfFloat)
            }
        };
    }

    function chooseRenderableFormat(context, internalFormat, format, type) {
        if (canRenderToTexture(context, internalFormat, format, type)) {
            return { internalFormat, format };
        }

        if (internalFormat === context.R16F) {
            return chooseRenderableFormat(context, context.RG16F, context.RG, type);
        }
        if (internalFormat === context.RG16F) {
            return chooseRenderableFormat(context, context.RGBA16F, context.RGBA, type);
        }
        return null;
    }

    function canRenderToTexture(context, internalFormat, format, type) {
        const testTexture = context.createTexture();
        const testFramebuffer = context.createFramebuffer();

        context.bindTexture(context.TEXTURE_2D, testTexture);
        context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MIN_FILTER, context.NEAREST);
        context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MAG_FILTER, context.NEAREST);
        context.texParameteri(context.TEXTURE_2D, context.TEXTURE_WRAP_S, context.CLAMP_TO_EDGE);
        context.texParameteri(context.TEXTURE_2D, context.TEXTURE_WRAP_T, context.CLAMP_TO_EDGE);
        context.texImage2D(context.TEXTURE_2D, 0, internalFormat, 4, 4, 0, format, type, null);

        context.bindFramebuffer(context.FRAMEBUFFER, testFramebuffer);
        context.framebufferTexture2D(
            context.FRAMEBUFFER,
            context.COLOR_ATTACHMENT0,
            context.TEXTURE_2D,
            testTexture,
            0
        );

        const isComplete = context.checkFramebufferStatus(context.FRAMEBUFFER)
            === context.FRAMEBUFFER_COMPLETE;

        context.deleteFramebuffer(testFramebuffer);
        context.deleteTexture(testTexture);
        return isComplete;
    }

    const shaderSource = {
        vertex: `
            precision highp float;
            attribute vec2 aCorner;
            varying vec2 uv;
            varying vec2 uvLeft;
            varying vec2 uvRight;
            varying vec2 uvUp;
            varying vec2 uvDown;
            uniform vec2 pixelStep;

            void main () {
                uv = aCorner * 0.5 + 0.5;
                uvLeft = uv - vec2(pixelStep.x, 0.0);
                uvRight = uv + vec2(pixelStep.x, 0.0);
                uvUp = uv + vec2(0.0, pixelStep.y);
                uvDown = uv - vec2(0.0, pixelStep.y);
                gl_Position = vec4(aCorner, 0.0, 1.0);
            }
        `,
        fade: `
            precision highp float;
            varying vec2 uv;
            uniform sampler2D sourceMap;
            uniform float retention;

            void main () {
                gl_FragColor = texture2D(sourceMap, uv) * retention;
            }
        `,
        present: `
            precision highp float;
            varying vec2 uv;
            uniform sampler2D pigmentMap;
            uniform sampler2D flowMap;
            uniform vec2 pixelStep;
            uniform float time;
            uniform float interactionEnabled;
            uniform float distortionStrength;

            void main () {
                vec2 flow = texture2D(flowMap, uv).xy;
                vec2 flowOffset = clamp(flow * pixelStep, -0.12, 0.12);
                vec2 backgroundUv = clamp(
                    uv - flowOffset
                        * distortionStrength
                        * interactionEnabled,
                    0.0,
                    1.0
                );
                vec2 gradientCenter = vec2(
                    0.86 + sin(time * 0.24) * 0.07,
                    0.55 + cos(time * 0.19) * 0.08
                );
                vec2 gradientOffset = backgroundUv - gradientCenter;
                gradientOffset.x *= 0.82;
                float blueField = 1.0 - smoothstep(0.12, 0.72, length(gradientOffset));
                float rightWash = smoothstep(0.14, 1.0, backgroundUv.x);
                float lowerGlow = 1.0 - smoothstep(
                    0.08,
                    0.62,
                    length(backgroundUv - vec2(0.62 + cos(time * 0.16) * 0.08, 0.08))
                );

                vec3 backgroundColor = mix(
                    vec3(1.0),
                    vec3(0.78, 0.92, 1.0),
                    rightWash * 0.56
                );
                backgroundColor = mix(
                    backgroundColor,
                    vec3(0.08, 0.49, 0.98),
                    blueField * 0.74
                );
                backgroundColor = mix(
                    backgroundColor,
                    vec3(0.72, 0.90, 1.0),
                    lowerGlow * 0.28
                );

                vec2 whitePocketA = backgroundUv - vec2(
                    0.75 + sin(time * 0.156) * 0.08,
                    0.78 + cos(time * 0.204) * 0.05
                );
                whitePocketA.x *= 1.45;
                vec2 whitePocketB = backgroundUv - vec2(
                    0.92 + cos(time * 0.12) * 0.05,
                    0.43 + sin(time * 0.168) * 0.09
                );
                whitePocketB.x *= 1.7;
                vec2 whitePocketC = backgroundUv - vec2(
                    0.68 + sin(time * 0.108) * 0.07,
                    0.17 + cos(time * 0.144) * 0.04
                );
                whitePocketC.x *= 1.25;

                float whitePockets = max(
                    1.0 - smoothstep(0.04, 0.22, length(whitePocketA)),
                    max(
                        1.0 - smoothstep(0.03, 0.18, length(whitePocketB)),
                        1.0 - smoothstep(0.04, 0.20, length(whitePocketC))
                    )
                );
                backgroundColor = mix(
                    backgroundColor,
                    vec3(1.0),
                    whitePockets * 0.78
                );

                vec3 pigment = texture2D(pigmentMap, uv).rgb;
                float peak = max(max(pigment.r, pigment.g), pigment.b);
                float visibility = clamp(peak, 0.0, 1.0);
                vec3 pigmentHue = clamp(pigment / max(peak, 0.001), 0.0, 1.0);
                float blueBias = clamp(
                    0.28 + (pigmentHue.b - pigmentHue.r) * 1.35,
                    0.0,
                    1.0
                );
                vec3 coolFlame = mix(
                    vec3(0.08, 0.82, 1.0),
                    vec3(0.015, 0.42, 1.0),
                    blueBias
                );
                float hotCore = smoothstep(0.78, 1.0, visibility);
                vec3 glowColor = mix(
                    coolFlame,
                    vec3(0.48, 0.92, 1.0),
                    hotCore * 0.2
                );
                float colorNeutrality = clamp(
                    pigmentHue.r / max(pigmentHue.b, 0.001),
                    0.0,
                    1.0
                );
                float finalWhite = smoothstep(0.62, 0.9, colorNeutrality)
                    * smoothstep(0.34, 0.78, visibility);
                glowColor = mix(
                    glowColor,
                    vec3(1.0),
                    finalWhite * 0.96
                );
                float opacity = smoothstep(0.1, 0.6, visibility);
                opacity = opacity * opacity * 0.9;
                vec3 glowLayer = glowColor * visibility * opacity;
                vec3 compositedColor = vec3(1.0)
                    - (vec3(1.0) - backgroundColor) * (vec3(1.0) - glowLayer);
                gl_FragColor = vec4(
                    compositedColor,
                    1.0
                );
            }
        `,
        inject: `
            precision highp float;
            varying vec2 uv;
            uniform sampler2D baseMap;
            uniform float viewportRatio;
            uniform vec3 amount;
            uniform vec2 origin;
            uniform float spread;

            void main () {
                vec2 offset = uv - origin;
                offset.x *= viewportRatio;
                float influence = exp(-dot(offset, offset) / spread);
                vec3 previous = texture2D(baseMap, uv).xyz;
                gl_FragColor = vec4(previous + influence * amount, 1.0);
            }
        `,
        transport: `
            precision highp float;
            varying vec2 uv;
            uniform sampler2D flowMap;
            uniform sampler2D carriedMap;
            uniform vec2 pixelStep;
            uniform float elapsed;
            uniform float retention;

            void main () {
                vec2 previousUv = uv
                    - texture2D(flowMap, uv).xy * pixelStep * elapsed;
                gl_FragColor = texture2D(carriedMap, previousUv) * retention;
                gl_FragColor.a = 1.0;
            }
        `,
        transportManual: `
            precision highp float;
            varying vec2 uv;
            uniform sampler2D flowMap;
            uniform sampler2D carriedMap;
            uniform vec2 pixelStep;
            uniform float elapsed;
            uniform float retention;

            vec4 interpolateFourSamples(sampler2D map, vec2 gridPosition) {
                vec2 lower = floor(gridPosition - 0.5) + 0.5;
                vec2 upper = lower + 1.0;
                vec2 blend = gridPosition - lower;
                vec4 lowerLeft = texture2D(map, lower * pixelStep);
                vec4 lowerRight = texture2D(map, vec2(upper.x, lower.y) * pixelStep);
                vec4 upperLeft = texture2D(map, vec2(lower.x, upper.y) * pixelStep);
                vec4 upperRight = texture2D(map, upper * pixelStep);
                return mix(
                    mix(lowerLeft, lowerRight, blend.x),
                    mix(upperLeft, upperRight, blend.x),
                    blend.y
                );
            }

            void main () {
                vec2 previousGridPosition = gl_FragCoord.xy
                    - texture2D(flowMap, uv).xy * elapsed;
                gl_FragColor = interpolateFourSamples(carriedMap, previousGridPosition)
                    * retention;
                gl_FragColor.a = 1.0;
            }
        `,
        spin: `
            precision highp float;
            varying vec2 uvLeft;
            varying vec2 uvRight;
            varying vec2 uvUp;
            varying vec2 uvDown;
            uniform sampler2D flowMap;

            void main () {
                float left = texture2D(flowMap, uvLeft).y;
                float right = texture2D(flowMap, uvRight).y;
                float up = texture2D(flowMap, uvUp).x;
                float down = texture2D(flowMap, uvDown).x;
                gl_FragColor = vec4(right - left - up + down, 0.0, 0.0, 1.0);
            }
        `,
        addSwirl: `
            precision highp float;
            varying vec2 uv;
            varying vec2 uvUp;
            varying vec2 uvDown;
            uniform sampler2D flowMap;
            uniform sampler2D spinMap;
            uniform float strength;
            uniform float elapsed;

            void main () {
                float above = texture2D(spinMap, uvUp).x;
                float below = texture2D(spinMap, uvDown).x;
                float center = texture2D(spinMap, uv).x;
                vec2 direction = vec2(abs(above) - abs(below), 0.0);
                direction *= strength * center / length(direction + 0.00001);
                vec2 flow = texture2D(flowMap, uv).xy;
                gl_FragColor = vec4(flow + direction * elapsed, 0.0, 1.0);
            }
        `,
        expansion: `
            precision highp float;
            varying vec2 uvLeft;
            varying vec2 uvRight;
            varying vec2 uvUp;
            varying vec2 uvDown;
            uniform sampler2D flowMap;

            vec2 readFlow(vec2 sampleUv) {
                vec2 edgeSign = vec2(1.0);
                if (sampleUv.x < 0.0) { sampleUv.x = 0.0; edgeSign.x = -1.0; }
                if (sampleUv.x > 1.0) { sampleUv.x = 1.0; edgeSign.x = -1.0; }
                if (sampleUv.y < 0.0) { sampleUv.y = 0.0; edgeSign.y = -1.0; }
                if (sampleUv.y > 1.0) { sampleUv.y = 1.0; edgeSign.y = -1.0; }
                return texture2D(flowMap, sampleUv).xy * edgeSign;
            }

            void main () {
                float left = readFlow(uvLeft).x;
                float right = readFlow(uvRight).x;
                float up = readFlow(uvUp).y;
                float down = readFlow(uvDown).y;
                gl_FragColor = vec4(0.5 * (right - left + up - down), 0.0, 0.0, 1.0);
            }
        `,
        solvePressure: `
            precision highp float;
            varying vec2 uv;
            varying vec2 uvLeft;
            varying vec2 uvRight;
            varying vec2 uvUp;
            varying vec2 uvDown;
            uniform sampler2D pressureMap;
            uniform sampler2D expansionMap;

            vec2 keepInside(vec2 sampleUv) {
                return clamp(sampleUv, 0.0, 1.0);
            }

            void main () {
                float left = texture2D(pressureMap, keepInside(uvLeft)).x;
                float right = texture2D(pressureMap, keepInside(uvRight)).x;
                float up = texture2D(pressureMap, keepInside(uvUp)).x;
                float down = texture2D(pressureMap, keepInside(uvDown)).x;
                float expansion = texture2D(expansionMap, uv).x;
                gl_FragColor = vec4((left + right + up + down - expansion) * 0.25, 0.0, 0.0, 1.0);
            }
        `,
        project: `
            precision highp float;
            varying vec2 uv;
            varying vec2 uvLeft;
            varying vec2 uvRight;
            varying vec2 uvUp;
            varying vec2 uvDown;
            uniform sampler2D pressureMap;
            uniform sampler2D flowMap;

            vec2 keepInside(vec2 sampleUv) {
                return clamp(sampleUv, 0.0, 1.0);
            }

            void main () {
                float left = texture2D(pressureMap, keepInside(uvLeft)).x;
                float right = texture2D(pressureMap, keepInside(uvRight)).x;
                float up = texture2D(pressureMap, keepInside(uvUp)).x;
                float down = texture2D(pressureMap, keepInside(uvDown)).x;
                vec2 flow = texture2D(flowMap, uv).xy;
                flow -= vec2(right - left, up - down);
                gl_FragColor = vec4(flow, 0.0, 1.0);
            }
        `
    };

    function compileShader(type, source) {
        const shader = gl.createShader(type);
        gl.shaderSource(shader, source);
        gl.compileShader(shader);

        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
            const message = gl.getShaderInfoLog(shader);
            gl.deleteShader(shader);
            throw new Error(message);
        }
        return shader;
    }

    class RenderPass {
        constructor(fragmentSource) {
            const vertexShader = compileShader(gl.VERTEX_SHADER, shaderSource.vertex);
            const fragmentShader = compileShader(gl.FRAGMENT_SHADER, fragmentSource);
            this.program = gl.createProgram();

            gl.attachShader(this.program, vertexShader);
            gl.attachShader(this.program, fragmentShader);
            gl.bindAttribLocation(this.program, 0, 'aCorner');
            gl.linkProgram(this.program);
            gl.deleteShader(vertexShader);
            gl.deleteShader(fragmentShader);

            if (!gl.getProgramParameter(this.program, gl.LINK_STATUS)) {
                throw new Error(gl.getProgramInfoLog(this.program));
            }

            this.uniform = {};
            const uniformTotal = gl.getProgramParameter(this.program, gl.ACTIVE_UNIFORMS);
            for (let index = 0; index < uniformTotal; index += 1) {
                const name = gl.getActiveUniform(this.program, index).name;
                this.uniform[name] = gl.getUniformLocation(this.program, name);
            }
        }

        use() {
            gl.useProgram(this.program);
        }
    }

    const passes = {
        fade: new RenderPass(shaderSource.fade),
        present: new RenderPass(shaderSource.present),
        inject: new RenderPass(shaderSource.inject),
        transport: new RenderPass(
            textureSupport.linearFiltering
                ? shaderSource.transport
                : shaderSource.transportManual
        ),
        spin: new RenderPass(shaderSource.spin),
        addSwirl: new RenderPass(shaderSource.addSwirl),
        expansion: new RenderPass(shaderSource.expansion),
        solvePressure: new RenderPass(shaderSource.solvePressure),
        project: new RenderPass(shaderSource.project)
    };

    const screenMesh = createScreenMesh();

    function createScreenMesh() {
        const vertexBuffer = gl.createBuffer();
        const indexBuffer = gl.createBuffer();

        gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
        gl.bufferData(
            gl.ARRAY_BUFFER,
            new Float32Array([-1, -1, -1, 1, 1, 1, 1, -1]),
            gl.STATIC_DRAW
        );
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
        gl.bufferData(
            gl.ELEMENT_ARRAY_BUFFER,
            new Uint16Array([0, 1, 2, 0, 2, 3]),
            gl.STATIC_DRAW
        );
        gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
        gl.enableVertexAttribArray(0);

        return {
            draw(framebuffer = null) {
                gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
                gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0);
            }
        };
    }

    let fieldWidth = 0;
    let fieldHeight = 0;
    let nextTextureUnit = 0;
    let fields = null;

    function createSurface(width, height, textureFormat, filtering) {
        const textureUnit = nextTextureUnit;
        nextTextureUnit += 1;

        gl.activeTexture(gl.TEXTURE0 + textureUnit);
        const texture = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filtering);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filtering);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texImage2D(
            gl.TEXTURE_2D,
            0,
            textureFormat.internalFormat,
            width,
            height,
            0,
            textureFormat.format,
            textureSupport.halfFloatType,
            null
        );

        const framebuffer = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
        gl.framebufferTexture2D(
            gl.FRAMEBUFFER,
            gl.COLOR_ATTACHMENT0,
            gl.TEXTURE_2D,
            texture,
            0
        );
        gl.viewport(0, 0, width, height);
        gl.clear(gl.COLOR_BUFFER_BIT);

        return { texture, framebuffer, textureUnit };
    }

    function createSurfacePair(width, height, textureFormat, filtering) {
        let front = createSurface(width, height, textureFormat, filtering);
        let back = createSurface(width, height, textureFormat, filtering);

        return {
            get read() { return front; },
            get write() { return back; },
            swap() { [front, back] = [back, front]; }
        };
    }

    function releaseSurface(surface) {
        gl.deleteFramebuffer(surface.framebuffer);
        gl.deleteTexture(surface.texture);
    }

    function releaseFields() {
        if (!fields) return;
        releaseSurface(fields.pigment.read);
        releaseSurface(fields.pigment.write);
        releaseSurface(fields.flow.read);
        releaseSurface(fields.flow.write);
        releaseSurface(fields.pressure.read);
        releaseSurface(fields.pressure.write);
        releaseSurface(fields.expansion);
        releaseSurface(fields.spin);
    }

    function rebuildFields() {
        releaseFields();
        nextTextureUnit = 0;
        fieldWidth = gl.drawingBufferWidth >> simulation.resolutionShift;
        fieldHeight = gl.drawingBufferHeight >> simulation.resolutionShift;

        const smooth = textureSupport.linearFiltering ? gl.LINEAR : gl.NEAREST;
        fields = {
            flow: createSurfacePair(fieldWidth, fieldHeight, textureSupport.rg, smooth),
            pigment: createSurfacePair(fieldWidth, fieldHeight, textureSupport.rgba, smooth),
            pressure: createSurfacePair(fieldWidth, fieldHeight, textureSupport.red, gl.NEAREST),
            expansion: createSurface(fieldWidth, fieldHeight, textureSupport.red, gl.NEAREST),
            spin: createSurface(fieldWidth, fieldHeight, textureSupport.red, gl.NEAREST)
        };
    }

    function bindTexture(uniformLocation, surface) {
        gl.activeTexture(gl.TEXTURE0 + surface.textureUnit);
        gl.bindTexture(gl.TEXTURE_2D, surface.texture);
        gl.uniform1i(uniformLocation, surface.textureUnit);
    }

    function setPixelStep(pass) {
        if (pass.uniform.pixelStep !== undefined) {
            gl.uniform2f(pass.uniform.pixelStep, 1 / fieldWidth, 1 / fieldHeight);
        }
    }

    function resizeIfNeeded() {
        const width = canvas.clientWidth;
        const height = canvas.clientHeight;
        if (canvas.width === width && canvas.height === height) return;
        canvas.width = width;
        canvas.height = height;
        rebuildFields();
    }

    function transportFields(elapsed) {
        const pass = passes.transport;
        pass.use();
        setPixelStep(pass);
        gl.uniform1f(pass.uniform.elapsed, elapsed);

        bindTexture(pass.uniform.flowMap, fields.flow.read);
        bindTexture(pass.uniform.carriedMap, fields.flow.read);
        gl.uniform1f(pass.uniform.retention, simulation.motionRetention);
        screenMesh.draw(fields.flow.write.framebuffer);
        fields.flow.swap();

        bindTexture(pass.uniform.flowMap, fields.flow.read);
        bindTexture(pass.uniform.carriedMap, fields.pigment.read);
        gl.uniform1f(pass.uniform.retention, simulation.pigmentRetention);
        screenMesh.draw(fields.pigment.write.framebuffer);
        fields.pigment.swap();
    }

    function addImpulse(
        normalizedX,
        normalizedY,
        forceX,
        forceY,
        color,
        spread = simulation.brushRadius
    ) {
        const pass = passes.inject;
        pass.use();
        gl.uniform1f(pass.uniform.viewportRatio, canvas.width / canvas.height);
        gl.uniform2f(pass.uniform.origin, normalizedX, 1 - normalizedY);
        gl.uniform1f(pass.uniform.spread, spread);

        bindTexture(pass.uniform.baseMap, fields.flow.read);
        gl.uniform3f(pass.uniform.amount, forceX, -forceY, 1);
        screenMesh.draw(fields.flow.write.framebuffer);
        fields.flow.swap();

        bindTexture(pass.uniform.baseMap, fields.pigment.read);
        gl.uniform3f(
            pass.uniform.amount,
            color[0] * 0.3,
            color[1] * 0.3,
            color[2] * 0.3
        );
        screenMesh.draw(fields.pigment.write.framebuffer);
        fields.pigment.swap();
    }

    function applyPointerImpulse() {
        if (!pointer.pending) return;
        addImpulse(pointer.x, pointer.y, pointer.dx, pointer.dy, pointer.color);
        pointer.pending = false;
    }

    function preserveSwirls(elapsed) {
        const spinPass = passes.spin;
        spinPass.use();
        setPixelStep(spinPass);
        bindTexture(spinPass.uniform.flowMap, fields.flow.read);
        screenMesh.draw(fields.spin.framebuffer);

        const swirlPass = passes.addSwirl;
        swirlPass.use();
        setPixelStep(swirlPass);
        bindTexture(swirlPass.uniform.flowMap, fields.flow.read);
        bindTexture(swirlPass.uniform.spinMap, fields.spin);
        gl.uniform1f(swirlPass.uniform.strength, simulation.swirlStrength);
        gl.uniform1f(swirlPass.uniform.elapsed, elapsed);
        screenMesh.draw(fields.flow.write.framebuffer);
        fields.flow.swap();
    }

    function makeFlowIncompressible() {
        const expansionPass = passes.expansion;
        expansionPass.use();
        setPixelStep(expansionPass);
        bindTexture(expansionPass.uniform.flowMap, fields.flow.read);
        screenMesh.draw(fields.expansion.framebuffer);

        const fadePass = passes.fade;
        fadePass.use();
        bindTexture(fadePass.uniform.sourceMap, fields.pressure.read);
        gl.uniform1f(fadePass.uniform.retention, simulation.pressureRetention);
        screenMesh.draw(fields.pressure.write.framebuffer);
        fields.pressure.swap();

        const pressurePass = passes.solvePressure;
        pressurePass.use();
        setPixelStep(pressurePass);
        bindTexture(pressurePass.uniform.expansionMap, fields.expansion);

        for (let passNumber = 0; passNumber < simulation.pressurePasses; passNumber += 1) {
            bindTexture(pressurePass.uniform.pressureMap, fields.pressure.read);
            screenMesh.draw(fields.pressure.write.framebuffer);
            fields.pressure.swap();
        }

        const projectPass = passes.project;
        projectPass.use();
        setPixelStep(projectPass);
        bindTexture(projectPass.uniform.pressureMap, fields.pressure.read);
        bindTexture(projectPass.uniform.flowMap, fields.flow.read);
        screenMesh.draw(fields.flow.write.framebuffer);
        fields.flow.swap();
    }

    function displayPigment(currentTime) {
        gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
        const pass = passes.present;
        pass.use();
        setPixelStep(pass);
        gl.uniform1f(pass.uniform.time, currentTime * 0.001);
        gl.uniform1f(
            pass.uniform.interactionEnabled,
            backgroundInteraction.enabled ? 1 : 0
        );
        gl.uniform1f(pass.uniform.distortionStrength, backgroundInteraction.distortionStrength);
        bindTexture(pass.uniform.flowMap, fields.flow.read);
        bindTexture(pass.uniform.pigmentMap, fields.pigment.read);
        screenMesh.draw();
    }

    const automaticFlow = {
        nextStrokeAt: performance.now() + 120,
        activeStrokes: []
    };

    function randomBetween(minimum, maximum) {
        return minimum + Math.random() * (maximum - minimum);
    }

    function keepInFrame(value) {
        return Math.min(Math.max(value, 0.08), 0.92);
    }

    function cubicBezier(start, controlA, controlB, end, amount) {
        const inverse = 1 - amount;
        return inverse ** 3 * start
            + 3 * inverse ** 2 * amount * controlA
            + 3 * inverse * amount ** 2 * controlB
            + amount ** 3 * end;
    }

    function easeBetween(edgeA, edgeB, value) {
        const normalized = Math.min(Math.max((value - edgeA) / (edgeB - edgeA), 0), 1);
        return normalized * normalized * (3 - 2 * normalized);
    }

    function createRandomStroke(startedAt) {
        const start = [randomBetween(0.12, 0.88), randomBetween(0.12, 0.88)];
        const angle = randomBetween(0, Math.PI * 2);
        const distance = randomBetween(0.14, 0.34);
        const bend = randomBetween(-0.13, 0.13);
        const direction = [Math.cos(angle), Math.sin(angle)];
        const normal = [-direction[1], direction[0]];
        const end = [
            keepInFrame(start[0] + direction[0] * distance),
            keepInFrame(start[1] + direction[1] * distance)
        ];

        const duration = Math.random() < 0.35
            ? randomBetween(2200, 4200)
            : randomBetween(900, 1800);

        return {
            startedAt,
            duration,
            spread: randomBetween(0.0012, 0.008),
            start,
            controlA: [
                keepInFrame(start[0] + direction[0] * distance * 0.3 + normal[0] * bend),
                keepInFrame(start[1] + direction[1] * distance * 0.3 + normal[1] * bend)
            ],
            controlB: [
                keepInFrame(start[0] + direction[0] * distance * 0.72 + normal[0] * bend),
                keepInFrame(start[1] + direction[1] * distance * 0.72 + normal[1] * bend)
            ],
            end,
            previousPoint: start,
            colorOffset: Math.random()
        };
    }

    function updateAutomaticFlow(currentTime) {
        if (currentTime >= automaticFlow.nextStrokeAt) {
            automaticFlow.activeStrokes.push(createRandomStroke(currentTime));
            automaticFlow.nextStrokeAt = currentTime + randomBetween(1800, 3600);
        }

        automaticFlow.activeStrokes = automaticFlow.activeStrokes.filter((stroke) => {
            const progress = Math.min((currentTime - stroke.startedAt) / stroke.duration, 1);
            const point = [
                cubicBezier(
                    stroke.start[0],
                    stroke.controlA[0],
                    stroke.controlB[0],
                    stroke.end[0],
                    progress
                ),
                cubicBezier(
                    stroke.start[1],
                    stroke.controlA[1],
                    stroke.controlB[1],
                    stroke.end[1],
                    progress
                )
            ];
            const movementX = point[0] - stroke.previousPoint[0];
            const movementY = point[1] - stroke.previousPoint[1];
            const movingColor = sampleBlueGradient(
                (stroke.colorOffset + progress * 0.7) % 1
            );
            const whitening = easeBetween(0.9, 0.99, progress);
            const disappearingColor = [2.2, 2.2, 2.2];
            const color = movingColor.map((channel, index) => (
                channel + (disappearingColor[index] - channel) * whitening
            ));
            addImpulse(
                point[0],
                point[1],
                movementX * canvas.width * 8,
                movementY * canvas.height * 8,
                color,
                stroke.spread
            );
            stroke.previousPoint = point;

            return progress < 1;
        });
    }

    const pointer = {
        initialized: false,
        pending: false,
        x: 0,
        y: 0,
        dx: 0,
        dy: 0,
        colorDistance: 0,
        color: [1, 1, 1]
    };

    canvas.addEventListener('pointermove', (event) => {
        const bounds = canvas.getBoundingClientRect();
        const nextX = (event.clientX - bounds.left) / bounds.width;
        const nextY = (event.clientY - bounds.top) / bounds.height;

        pointer.pending = pointer.initialized;
        pointer.dx = (nextX - pointer.x) * canvas.width * 5;
        pointer.dy = (nextY - pointer.y) * canvas.height * 5;
        pointer.x = nextX;
        pointer.y = nextY;
        pointer.colorDistance += Math.hypot(pointer.dx, pointer.dy) / 500;
        const gradientPosition = 0.5 - 0.5 * Math.cos(pointer.colorDistance);
        pointer.color = sampleBlueGradient(gradientPosition);
        pointer.initialized = true;
    });

    canvas.addEventListener('pointerleave', () => {
        pointer.initialized = false;
        pointer.pending = false;
    });

    resizeIfNeeded();
    let previousFrameTime = performance.now();

    function animate(currentTime) {
        resizeIfNeeded();
        const elapsed = Math.min((currentTime - previousFrameTime) / 1000, 0.016);
        previousFrameTime = currentTime;

        gl.viewport(0, 0, fieldWidth, fieldHeight);
        transportFields(elapsed);
        updateAutomaticFlow(currentTime);
        applyPointerImpulse();
        preserveSwirls(elapsed);
        makeFlowIncompressible();
        displayPigment(currentTime);
        requestAnimationFrame(animate);
    }

    requestAnimationFrame(animate);
})();
