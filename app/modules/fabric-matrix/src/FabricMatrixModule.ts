import { NativeModule, requireNativeModule } from 'expo';

declare class FabricMatrixModule extends NativeModule<{}> {}

export default requireNativeModule<FabricMatrixModule>('FabricMatrix');
